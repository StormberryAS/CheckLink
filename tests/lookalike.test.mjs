// Stage 3 look-alike checks (src/lookalike.js, with src/confusables.js and src/brands.js), as
// link-core.js reports them: known homograph, typosquat, combosquat and digit-swap samples get a
// Check note that names the domain they imitate, and the 27,000-odd real names in
// tests/fixtures/real-domains.txt get none. tests/lookalike-review.test.mjs holds the look-alike
// review of 10 October 2026, whose findings stage 3 fixed.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse } from '../src/link-core.js';
import { brandMatch, decodeHost, lookAlike, punyDecode, skeleton, typoKind } from '../src/lookalike.js';
import { CONFUSABLES, CONFUSABLES_VERSION } from '../src/confusables.js';
import { BRANDS, LURES } from '../src/brands.js';
import { checkAll as brandsCheck } from '../tools/brands.mjs';
import { KNOWN } from './fixtures/real-domains-known.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = (input) => analyse(input);
const LOOK = new Set(['look-alike-letters', 'look-alike-symbol', 'look-alike-brand', 'hidden-look-alike']);
const looks = (r) => r.warnings.filter((w) => LOOK.has(w.id));
const show = (r) => JSON.stringify(r.warnings.map((w) => `${w.id}/${w.tier}: ${w.text}`));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The note names the brand, its own domain, and the domain the address really belongs to, each as
// a whole name (evil.io inside paypal.com.evil.io does not count for the last).
function named(r, brand, own, owner) {
  return r.warnings.find((w) => w.tier === 'check' && LOOK.has(w.id) && w.text.includes(brand)
    && new RegExp(`(^|[^a-z0-9.-])${esc(own)}([^a-z0-9-]|$)`).test(w.text)
    && (!owner || new RegExp(`(^|[^a-z0-9.\\-])${esc(owner)}([^a-z0-9-]|$)`, 'u').test(w.text)));
}

// == the vendored and curated data ==

describe('stage 3 data', () => {
  test('the confusables table is the ASCII part of Unicode 18.0.0: 2,561 characters', () => {
    assert.equal(CONFUSABLES_VERSION, '18.0.0');
    assert.equal(Object.keys(CONFUSABLES).length, 2561);
    for (const [cp, want] of [[0x0430, 'a'], [0x0585, 'o'], [0xABA9, 'v'], [0x0261, 'g'], [0x0030, 'O'], [0x0031, 'l'], [0x006D, 'rn'], [0x2010, '-'], [0x2215, '/'], [0x00F8, 'o']]) {
      assert.equal(CONFUSABLES[cp], want, `U+${cp.toString(16)}`);
    }
  });

  test('the brand list is current, follows its rules, and every domain has a passing online check on record', () => {
    const { errors } = brandsCheck();
    assert.deepEqual(errors, []);
  });

  test('every provider family the brand list names exists in the rule files', () => {
    const data = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'brands.json'), 'utf8'));
    const pr = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'provider-rules.json'), 'utf8'));
    const families = new Set([...Object.keys(pr.stats.families), ...['hosts', 'functional_keep', 'path_rules', 'redirects'].flatMap((k) => pr[k].map((x) => x.family))]);
    for (const b of data.brands.filter((x) => x.group === 'provider')) {
      const fam = b.provider.replace(/ \(.*\)$/, '');
      assert.ok(families.has(b.provider) || families.has(fam) || /extra-rules/.test(b.provider), `${b.name}: ${b.provider}`);
    }
    for (const b of data.brands.filter((x) => x.group !== 'provider')) assert.ok(b.why, `${b.name} says why it is listed`);
  });

  test('the brand list covers the big providers and the names the spec names', () => {
    const names = new Set(BRANDS.map((b) => b.name));
    for (const n of ['Google', 'YouTube', 'Apple', 'Microsoft', 'Facebook', 'Instagram', 'WhatsApp', 'Amazon', 'eBay', 'Netflix', 'Spotify', 'TikTok', 'LinkedIn', 'PayPal', 'Vipps', 'DNB', 'Posten', 'BankID', 'NAV', 'Altinn', 'Correios', 'CTT']) assert.ok(names.has(n), n);
    assert.ok(LURES.strong.includes('login') && LURES.strong.includes('sikkerhet') && LURES.strong.includes('rastreio'));
  });
});

// == building blocks ==

describe('skeleton, punycode and typing slips', () => {
  test('skeleton reads look-alike letters as the Latin ones they pass for', () => {
    assert.equal(skeleton('p\u0430ypal'), 'paypal');
    assert.equal(skeleton('g\u0585\u0585gle'), 'google');
    assert.equal(skeleton('\u0261oogle'), 'google');
    assert.equal(skeleton('v\u00EDpps'), 'vipps');
    assert.equal(skeleton('p\u00F8sten'), 'posten');
    assert.equal(skeleton('paypa1'), 'paypal');
    assert.equal(skeleton('microsoft'), skeleton('rnicrosoft'));
    assert.equal(skeleton('bl\u00E5b\u00E6r'), 'blabaer');
  });

  test('punycode decodes back to the letters, and a broken label stays as it is', () => {
    assert.equal(punyDecode('pypal-4ve'), 'p\u0430ypal');
    assert.equal(decodeHost('xn--pple-43d.xn--p1ai'), '\u0430pple.\u0440\u0444');
    assert.equal(decodeHost('xn--zz.com'), 'xn--zz.com');
  });

  test('typing slips: doubled, left out, swapped, a neighbouring key; never the first letter', () => {
    assert.equal(typoKind('gooogle', 'google'), 'doubled');
    assert.equal(typoKind('facebok', 'facebook'), 'missing');
    assert.equal(typoKind('gogle', 'google'), 'missing');
    assert.equal(typoKind('revolt', 'revolut'), null, 'a short name losing a letter that is not doubled spells words');
    assert.equal(typoKind('googel', 'google'), 'swapped');
    assert.equal(typoKind('goigle', 'google'), 'neighbour');
    assert.equal(typoKind('hoogle', 'google'), null, 'the first letter is left alone');
    assert.equal(typoKind('gpogle', 'google'), 'neighbour');
    assert.equal(typoKind('gxogle', 'google'), null, 'x is nowhere near o');
  });
});

// == look-alikes that must be named ==

// Letters from another alphabet are shown named in brackets (interface review M1 of the stage 3
// fixes), so the decoded form in the note never looks exactly like the brand's own address;
// accented and other Latin letters are shown as they are, and the note says which letter was
// put in when one or two were (\u00F8 in place of o).
describe('homographs: letters from another alphabet, or with marks, that pass for a brand', () => {
  for (const [input, brand, own, decoded, encoded] of [
    ['https://p\u0430ypal.com/', 'PayPal', 'paypal.com', 'p[Cyrillic \u0430]ypal.com', 'xn--pypal-4ve.com'],
    ['https://\u0430\u0440\u0440\u04CF\u0435.com/', 'Apple', 'apple.com', '[Cyrillic \u0430\u0440\u0440\u04CF\u0435].com', 'xn--80ak6aa92e.com'],
    ['https://\u0430\u0440\u0440\u04CF\u0435.\u0440\u0444/', 'Apple', 'apple.com', '[Cyrillic \u0430\u0440\u0440\u04CF\u0435].\u0440\u0444', 'xn--80ak6aa92e.xn--p1ai'],
    ['https://g\u0585\u0585gle.com/', 'Google', 'google.com', 'g[Armenian \u0585\u0585]gle.com', 'xn--ggle-vifa.com'],
    // The browser writes the Cherokee small letter as its capital (U+13D9), so that is what shows.
    ['https://\uABA9ipps.no/', 'Vipps', 'vipps.no', '[Cherokee \u13D9]ipps.no', 'xn--ipps-uhu.no'],
    ['https://\u0261oogle.com/', 'Google', 'google.com', '\u0261oogle.com', 'xn--oogle-qmc.com'],
    ['https://v\u00EDpps.no/', 'Vipps', 'vipps.no', 'v\u00EDpps.no', 'xn--vpps-vpa.no'],
    ['https://p\u00F8sten.no/', 'Posten', 'posten.no', 'p\u00F8sten.no', 'xn--psten-vua.no'],
    ['https://faceb\u043E\u043Ek.com/', 'Facebook', 'facebook.com', 'faceb[Cyrillic \u043E\u043E]k.com', null],
    ['https://\u0430mazon.co.uk/', 'Amazon', 'amazon.com', '[Cyrillic \u0430]mazon.co.uk', null],
    ['https://www.netfl\u0456x.com/login', 'Netflix', 'netflix.com', 'netfl[Cyrillic \u0456]x.com', null],
    ['https://xn--pypal-4ve.com/', 'PayPal', 'paypal.com', 'p[Cyrillic \u0430]ypal.com', 'xn--pypal-4ve.com'],
  ]) {
    test(`${input} names ${brand} (${own}), shown decoded and encoded`, () => {
      const r = A(input);
      const w = named(r, brand, own);
      assert.ok(w, show(r));
      assert.ok(w.text.includes(decoded), `${w.text} shows ${decoded}`);
      assert.ok(w.text.includes(encoded || r.host), `${w.text} shows ${encoded || r.host}`);
      assert.equal(looks(r).length, 1, `one note, not two: ${show(r)}`);
    });
  }
});

describe('typosquats: one slip from a brand CheckLink knows', () => {
  for (const [input, brand, own, how] of [
    ['https://gooogle.com/', 'Google', 'google.com', 'with a letter doubled'],
    ['https://paypall.com/', 'PayPal', 'paypal.com', 'with a letter doubled'],
    ['https://facebok.com/', 'Facebook', 'facebook.com', 'with a letter left out'],
    ['https://instgram.com/', 'Instagram', 'instagram.com', 'with a letter left out'],
    ['https://googel.com/', 'Google', 'google.com', 'with two letters swapped'],
    ['https://paypla.com/', 'PayPal', 'paypal.com', 'with two letters swapped'],
    ['https://goigle.com/', 'Google', 'google.com', 'with a letter changed to the one next to it on the keyboard'],
    ['https://netflux.com/', 'Netflix', 'netflix.com', 'with a letter changed to the one next to it on the keyboard'],
    ['https://youtubee.com/watch?v=x', 'YouTube', 'youtube.com', 'with a letter doubled'],
    ['https://linkedln.com/', 'LinkedIn', 'linkedin.com', 'with a small l in place of an i'],
    ['https://paypai.com/', 'PayPal', 'paypal.com', 'with an i in place of a small l'],
    ['https://www.microsofft.com/', 'Microsoft', 'microsoft.com', 'with a letter doubled'],
    ['https://skatteetatn.no/', 'Skatteetaten', 'skatteetaten.no', 'with a letter left out'],
    ['https://helsenorgee.no/', 'Helsenorge', 'helsenorge.no', 'with a letter doubled'],
    ['https://altinnn.no/', 'Altinn', 'altinn.no', 'with a letter doubled'],
  ]) {
    test(`${input} is named as a slip from ${own}`, () => {
      const r = A(input);
      const w = named(r, brand, own);
      assert.ok(w, show(r));
      if (how) assert.ok(w.text.includes(how), w.text);
    });
  }

  test('word marks (apple, amazon, posten) get no typo check: their slips spell other words', () => {
    for (const host of ['ample.com', 'amazin.com', 'poster.no', 'posted.no', 'bringe.no', 'stream.com']) assert.deepEqual(looks(A(`https://${host}/`)), [], host);
  });
});

describe('digit and letter swaps', () => {
  for (const [input, brand, own, detail] of [
    ['https://paypa1.com/', 'PayPal', 'paypal.com', 'the digit 1 in place of the letter l'],
    ['https://g00gle.com/', 'Google', 'google.com', 'the digit 0 in place of the letter o'],
    ['https://faceb00k.com/', 'Facebook', 'facebook.com', 'the digit 0 in place of the letter o'],
    ['https://vipp5.no/', 'Vipps', 'vipps.no', 'the digit 5 in place of the letter s'],
    ['https://netfl1x.com/', 'Netflix', 'netflix.com', 'the digit 1 in place of the letter i'],
    ['https://amaz0n.com/', 'Amazon', 'amazon.com', 'the digit 0 in place of the letter o'],
    ['https://www.p0sten.no/', 'Posten', 'posten.no', 'the digit 0 in place of the letter o'],
    ['https://rnicrosoft.com/', 'Microsoft', 'microsoft.com', 'rn in place of m'],
    ['https://arnazon.com/', 'Amazon', 'amazon.com', 'rn in place of m'],
    ['https://b4nkid.no/', 'BankID', 'bankid.no', 'the digit 4 in place of the letter a'],
  ]) {
    test(`${input} says what was swapped in`, () => {
      const r = A(input);
      const w = named(r, brand, own);
      assert.ok(w, show(r));
      assert.ok(w.text.includes(detail), w.text);
    });
  }

  test('real names with digits are left alone (3m, 1password, sparebank1, 1881, o2, 7-eleven, 24sevenoffice)', () => {
    for (const h of ['www.3m.com', '1password.com', 'www.sparebank1.no', 'www.1881.no', 'www.o2.co.uk', 'www.7-eleven.com', 'www.24sevenoffice.com', 'www.dhl4you.com']) assert.deepEqual(looks(A(`https://${h}/`)), [], h);
  });
});

describe('combosquats: a brand name joined to other words', () => {
  for (const [input, brand, own, owner] of [
    ['https://paypal-secure-login.com/', 'PayPal', 'paypal.com', 'paypal-secure-login.com'],
    ['https://paypallogin.com/', 'PayPal', 'paypal.com', 'paypallogin.com'],
    ['https://wwwpaypal.com/', 'PayPal', 'paypal.com', 'wwwpaypal.com'],
    ['https://apple-id-verify.com/', 'Apple', 'apple.com', 'apple-id-verify.com'],
    ['https://amazon-refund.net/', 'Amazon', 'amazon.com', 'amazon-refund.net'],
    ['https://netflix-billing-update.com/', 'Netflix', 'netflix.com', 'netflix-billing-update.com'],
    ['https://microsoft365-sharepoint.com/', 'Microsoft', 'microsoft365.com', 'microsoft365-sharepoint.com'],
    ['https://dnb-sikkerhet.no/', 'DNB', 'dnb.no', 'dnb-sikkerhet.no'],
    ['https://vipps-refusjon.com/', 'Vipps', 'vipps.no', 'vipps-refusjon.com'],
    ['https://posten-toll.com/', 'Posten', 'posten.no', 'posten-toll.com'],
    ['https://nav-utbetaling.com/', 'NAV', 'nav.no', 'nav-utbetaling.com'],
    ['https://bankid-fornyelse.no/', 'BankID', 'bankid.no', 'bankid-fornyelse.no'],
    ['https://correios-rastreio.com/', 'Correios', 'correios.com.br', 'correios-rastreio.com'],
    ['https://ctt-entregas.com/', 'CTT', 'ctt.pt', 'ctt-entregas.com'],
    ['https://steamcommunity-gift.com/', 'Steam', 'steamcommunity.com', 'steamcommunity-gift.com'],
    ['https://p\u0430ypal-login.com/', 'PayPal', 'paypal.com', null],
  ]) {
    test(`${input} names ${brand} and says the address belongs to ${owner || 'its own owner'}`, () => {
      const r = A(input);
      assert.ok(named(r, brand, own, owner), show(r));
    });
  }

  test('an ordinary word with a word mark in it is not a combosquat (apple-pie-recipes, amazon-rainforest, bring-it-on, finnair, appleinsider)', () => {
    for (const h of ['apple-pie-recipes.com', 'amazon-rainforest.org', 'bring-it-on.com', 'www.finnair.com', 'appleinsider.com', 'www.snapple.com', 'www.navigasjon.no', 'dnb-radio.com', 'posten-bring.example', 'booking-calendar.org']) {
      assert.deepEqual(looks(A(`https://${h}/`)), [], h);
    }
  });
});

describe('a brand\u2019s own domain written into a longer address, and free hosting', () => {
  for (const [input, brand, own, owner] of [
    ['https://paypal.com.evil.io/signin', 'PayPal', 'paypal.com', 'evil.io'],
    ['https://www.paypal.com.account.security.verify.session.id-48291.evil.io/', 'PayPal', 'paypal.com', 'evil.io'],
    ['https://appleid.apple.com.verify.top/', 'Apple', 'apple.com', 'verify.top'],
    ['https://login.microsoftonline.com.auth-session.io/', 'Microsoft', 'microsoftonline.com', 'auth-session.io'],
    ['https://www.dnb.no.secure-login.ru/', 'DNB', 'dnb.no', 'secure-login.ru'],
    ['https://paypal-com.evil.io/', 'PayPal', 'paypal.com', 'evil.io'],
    ['https://paypal.com-account-verify.io/', 'PayPal', 'paypal.com', 'com-account-verify.io'],
    ['https://paypal.pages.dev/', 'PayPal', 'paypal.com', 'paypal.pages.dev'],
    ['https://vipps.netlify.app/', 'Vipps', 'vipps.no', 'vipps.netlify.app'],
    ['https://posten.firebaseapp.com/', 'Posten', 'posten.no', 'posten.firebaseapp.com'],
    ['https://microsoft-login.github.io/', 'Microsoft', 'microsoft.com', 'microsoft-login.github.io'],
    ['https://paypal-login.blob.core.windows.net/', 'PayPal', 'paypal.com', 'paypal-login.blob.core.windows.net'],
  ]) {
    test(`${input} names ${brand} and ${owner}`, () => {
      const r = A(input);
      assert.ok(named(r, brand, own, owner), show(r));
    });
  }

  test('a free hosting note replaces the plain "anyone can make an address" note, which would repeat it', () => {
    const r = A('https://paypal.pages.dev/');
    assert.equal(r.warnings.find((w) => w.id === 'shared-domain'), undefined, show(r));
    assert.match(r.warnings.find((w) => w.id === 'look-alike-brand').text, /a name under pages\.dev that anyone can create/);
    assert.ok(A('https://someone.pages.dev/').warnings.find((w) => w.id === 'shared-domain'), 'without a brand the plain note stays');
  });

  test('the brand\u2019s own platforms, and its names under another ending, are left alone', () => {
    for (const h of ['youtube.googleapis.com', 'fonts.googleapis.com', 'io.withgoogle.com', 'www.amazon.co.uk', 'www.google.com.br', 'www.zalando.no', 'www.dnb.com', 'www.posten.se', 'nav.com', 'accounts.google.com', 'sporing.posten.no', 'login.microsoftonline.com', 'www.paypalobjects.com']) {
      assert.deepEqual(looks(A(`https://${h}/`)), [], h);
    }
  });

  test('a known wrapper is not called a look-alike of the brand it serves (microsoft.msafflnk.net, an impact.com host)', () => {
    const r = A('https://microsoft.msafflnk.net/c/1234567/791234/9876?u=https%3A%2F%2Fwww.microsoft.com%2Fen-gb%2Fstore%2Fb%2Fxbox&subId1=blog');
    assert.deepEqual(looks(r), [], show(r));
  });

  test('the look-alike stays named after the address disguise is removed, behind a redirect, and inside an address hidden in the link', () => {
    const r = A('https://www.dnb.no@dnb-sikkerhet.no/');
    assert.equal(r.cleanLink, 'https://dnb-sikkerhet.no/');
    assert.ok(named(r, 'DNB', 'dnb.no', 'dnb-sikkerhet.no'), show(r));
    const g = A('https://www.google.com/url?q=https://paypal.com.evil.io/&sa=D');
    assert.equal(g.host, 'paypal.com.evil.io');
    assert.ok(named(g, 'PayPal', 'paypal.com', 'evil.io'), show(g));
    const h = A('https://example.com/login?next=https://paypa1.com/');
    const w = h.warnings.find((x) => x.id === 'hidden-look-alike');
    assert.ok(w && w.tier === 'check' && w.text.startsWith('About the address hidden inside this link (in next=): ') && w.text.includes('paypal.com'), show(h));
  });
});

describe('symbols that look like a hyphen, a full stop or a slash', () => {
  for (const [cp, looksLike] of [[0x2010, 'a hyphen'], [0x2011, 'a hyphen'], [0x2013, 'a hyphen'], [0x2212, 'a hyphen'], [0x2215, 'a slash'], [0x2044, 'a slash'], [0x00B7, 'a full stop'], [0x2027, 'a full stop']]) {
    test(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} in a name is named as looking like ${looksLike}`, () => {
      const r = A(`https://www.norsk${String.fromCodePoint(cp)}tipping.no/`);
      const w = r.warnings.find((x) => x.id === 'look-alike-symbol');
      assert.ok(w && w.tier === 'check', show(r));
      assert.ok(w.text.includes(`looks like ${looksLike} but is not one`), w.text);
      assert.ok(w.text.includes('xn--'), 'the browser\u2019s form is shown');
    });
  }

  test('the note says what the name reads like, and the brand when it passes for one', () => {
    const w = A('https://www.norsk\u2010tipping.no/').warnings.find((x) => x.id === 'look-alike-symbol');
    assert.ok(w.text.includes('It reads like www.norsk-tipping.no'), w.text);
    assert.ok(w.text.includes("Norsk Tipping's own address, norsk-tipping.no"), w.text);
  });

  test('a slash look-alike that makes a name read as paypal.com with a path says where it belongs', () => {
    const r = A('https://www.paypal.com\u2215signin.evil.io/');
    const w = r.warnings.find((x) => x.id === 'look-alike-symbol');
    assert.ok(w.text.includes('It reads like www.paypal.com/signin.evil.io') && w.text.includes('It belongs to evil.io'), w.text);
  });

  test('the Catalan l\u00B7l and the katakana middle dot and long vowel mark in Japanese names are spelling, not look-alikes', () => {
    for (const h of ['col\u00B7legi.cat', 'paral\u00B7lel.cat', '\u30B3\u30FC\u30D2\u30FC.jp', '\u30A2\u30FB\u30A4.jp']) assert.deepEqual(looks(A(`https://${h}/`)), [], h);
  });
});

describe('letters from other alphabets', () => {
  test('Cyrillic letters that the stage 1 table lacked are recognised (izhitsa, ghe, omega)', () => {
    for (const h of ['\u0475\u0456\u0455\u0430.com', '\u043E\u0433\u0430\u0441\u04CF\u0435.com', '\u051D\u0456\u0461\u0430.no']) {
      assert.ok(A(`https://${h}/`).warnings.find((w) => w.id === 'look-alike-letters'), h);
    }
  });

  test('Armenian and Cherokee letters mixed into a Latin name are named by their alphabet', () => {
    assert.match(A('https://g\u0585\u0585gle.com/').warnings.find((w) => w.id === 'look-alike-letters').text, /^This address has Armenian letters/);
    assert.match(A('https://\uABA9ipps.no/').warnings.find((w) => w.id === 'look-alike-letters').text, /^This address has Cherokee letters/);
  });

  test('letters that do not pass for Latin, mixed into a Latin name, are still named', () => {
    const w = A('https://shop\u0E44\u0E17\u0E22.com/').warnings.find((x) => x.id === 'look-alike-letters');
    assert.ok(w && /^This address mixes letters from different alphabets \(Latin and Thai\)/.test(w.text) && w.text.includes('shop[Thai '), w && w.text);
  });

  test('a word written wholly in Cyrillic under a Cyrillic ending is ordinary (L1), unless it passes for a listed brand', () => {
    for (const h of ['\u0441\u0430\u0445\u0430\u0440.\u0440\u0444', '\u0440\u0443\u0441.\u0440\u0444', '\u043F\u0440\u0438\u043C\u0435\u0440.\u0440\u0444', '\u0442\u0440\u043E\u0438\u0446\u0430-\u0445\u0440\u0430\u043C.\u0440\u0443\u0441']) assert.deepEqual(looks(A(`https://${h}/`)), [], h);
    assert.ok(named(A('https://\u0430\u0440\u0440\u04CF\u0435.\u0440\u0444/'), 'Apple', 'apple.com'));
    assert.ok(A('https://\u0441\u043E\u0441\u043E.com/').warnings.find((w) => w.id === 'look-alike-letters'), 'under .com it is still named');
  });

  test('the ending itself is never a look-alike (.\u0440\u0443\u0441 reads like pyc, but it is the registry\u2019s name)', () => {
    assert.deepEqual(looks(A('https://\u0444\u0443\u0442\u0437\u0430\u043B.\u0440\u0443\u0441/')), []);
  });

  test('a Japanese name typed with its own full stop is not called disguised (L2); between Latin names it still is', () => {
    assert.equal(A('https://\u4F8B\u3048\u3002jp/').warnings.find((w) => w.id === 'disguised'), undefined);
    assert.equal(A('https://\u4F8B\u3048\uFF0Ejp/').warnings.find((w) => w.id === 'disguised'), undefined);
    assert.ok(A('https://google\u3002com/').warnings.find((w) => w.id === 'disguised'));
    assert.ok(A('https://\uFF47\uFF4F\uFF4F\uFF47\uFF4C\uFF45.com/').warnings.find((w) => w.id === 'disguised'), 'full-width letters still count');
  });

  test('a joiner the browser keeps in the name is spelling (L3); one it drops still counts', () => {
    assert.equal(A('https://\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.ir/').warnings.find((w) => w.id === 'disguised'), undefined);
    assert.ok(A('https://exam\u200Bple.com/').warnings.find((w) => w.id === 'disguised'));
    assert.ok(A('https://pay\u00ADpal.com/').warnings.find((w) => w.id === 'disguised'));
  });
});

// == real names ==

const REAL = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'real-domains.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));

describe('real names stay free of look-alike notes', () => {
  test(`the real-name list is large: ${REAL.length.toLocaleString('en-GB')} names, international ones among them`, () => {
    assert.ok(REAL.length > 25000, String(REAL.length));
    assert.ok(REAL.filter((h) => h.includes('xn--')).length > 1000);
    assert.ok(REAL.some((h) => h.endsWith('.no')) && REAL.some((h) => h.endsWith('.pt')) && REAL.some((h) => h.endsWith('.br')));
  });

  test('no real name gets a look-alike note', () => {
    const bad = [];
    for (const h of REAL) {
      const r = analyse(`https://${h}/`);
      const w = looks(r);
      if (w.length) bad.push(`${h}: ${w.map((x) => x.text).join(' | ')}`);
    }
    assert.deepEqual(bad, []);
  });

  test('the brand check alone stays silent on every real name, too', () => {
    const bad = REAL.filter((h) => !KNOWN[h] && brandMatch(h) && !/msafflnk/.test(h));
    assert.deepEqual(bad, []);
  });

  test('the few real names that are true look-alikes still get their note, as the fixture script records', () => {
    for (const [h, why] of Object.entries(KNOWN)) {
      if (/msafflnk/.test(h)) continue;
      const id = why.split(':')[0];
      assert.ok(analyse(`https://${h}/`).warnings.find((w) => w.id === id), h);
    }
  });
});

describe('wording', () => {
  test('notes are calm and plain: no "safe", "scam", "fake" or "malicious", no dashes as punctuation', () => {
    const inputs = ['https://paypa1.com/', 'https://paypal-secure-login.com/', 'https://paypal.pages.dev/', 'https://paypal.com.evil.io/', 'https://p\u0430ypal.com/', 'https://www.norsk\u2010tipping.no/', 'https://gooogle.com/', 'https://pay-pal.com/', 'https://\u0261oogle.com/', 'https://paypal.com-account-verify.io/'];
    for (const input of inputs) {
      for (const w of looks(A(input))) {
        assert.ok(!/\b(safe|scam|fake|malicious|phishing)\b/i.test(w.text), w.text);
        assert.ok(!w.text.includes('\u2014') && !w.text.replace(/xn--/g, '').includes('--'), w.text);
        assert.ok(!w.text.includes('!'), w.text);
      }
    }
  });

  test('each look-alike note ends by naming the brand\u2019s own address', () => {
    for (const input of ['https://paypa1.com/', 'https://vipps-refusjon.com/', 'https://posten.firebaseapp.com/', 'https://www.dnb.no.secure-login.ru/', 'https://googel.com/', 'https://correios-rastreio.com/']) {
      const w = A(input).warnings.find((x) => x.id === 'look-alike-brand');
      assert.match(w.text, /'s? own address is [a-z0-9.-]+\.$/, w.text);
    }
  });

  test('lookAlike gives all three findings for one host', () => {
    const r = lookAlike('www.paypal.xn--comsignin-ng4e.evil.io');
    assert.ok(r.symbol && r.brand && !r.letters);
  });
});
