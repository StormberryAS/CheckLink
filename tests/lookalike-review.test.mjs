// Look-alike accuracy review of src/link-core.js, 10 October 2026, brought into the repository by
// the stage 3 build on 11 October 2026. When it was written every finding below was a todo test
// (56 of its 66 tests); stage 3 (src/lookalike.js, src/brands.js, src/confusables.js) fixed or
// decided all of them, so they are ordinary tests now. What each group was:
//
//   P  a proven defect in what stage 1 built (the "reads like" text showed apple.xn--p1ai)
//   F  a look-alike a stage 1 check should have caught: hyphen, slash and dot look-alikes,
//      Cyrillic letters missing from a hand-made table, Armenian and Cherokee mixed into Latin
//   L  findings that needed a decision, taken in stage 3 the way browsers take them: a word
//      written wholly in Cyrillic under a Cyrillic ending is ordinary (L1, unless it passes for a
//      listed brand), a Japanese name typed with its own full stop is not disguised (L2), a
//      Persian joiner the browser keeps is spelling (L3), and a look-alike in an address hidden
//      inside a link is said on the first screen (L4)
//   S  brand look-alikes, which waited for stage 3's brand list: every brand named here is on it
//
// The guards at the end, real addresses that must stay free of Check notes, are unchanged.
// tests/lookalike.test.mjs holds the stage 3 tests proper, including the large list of real
// names in tests/fixtures/real-domains.txt.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const CORE = process.env.CHECKLINK_CORE || new URL('../src/link-core.js', import.meta.url).href;
const { analyse } = await import(CORE);

const A = (input) => analyse(input);
const warning = (r, id) => r.warnings.find((w) => w.id === id);
// What decides "No warning signs found" on the page (app.js: no Stop or Check warning).
const serious = (r) => r.warnings.filter((w) => w.tier === 'check' || w.tier === 'stop');
const show = (r) => JSON.stringify(r.warnings.map((w) => `${w.id}/${w.tier}: ${w.text}`));
// The brand note spec warning 5 describes ("This address mentions PayPal, but it belongs to
// paypal.pages.dev ... PayPal's own address is paypal.com."): a Check note that names the
// brand and the domain the address really belongs to, as a whole name (evil.io inside
// paypal.com.evil.io does not count).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const brandNote = (r, brand, owner) => r.warnings.find((w) => w.tier === 'check' && w.text.includes(brand)
  && new RegExp(`(^|[^a-z0-9.-])${esc(owner)}([^a-z0-9-]|$)`).test(w.text));
const u = (cp) => String.fromCodePoint(cp);

// == P. proven defects ==

describe('look-alike review: proven defects', () => {
  for (const [input, tld] of [['https://аpple.рф/', 'xn--p1ai'], ['https://pаypal.бг/', 'xn--90ae']]) {
    test(`P1 the "reads like" text never shows a country ending in its xn-- form (${input})`, () => {
      const w = warning(A(input), 'look-alike-letters');
      assert.ok(w, 'a Latin name with a Cyrillic letter in it still gets the note');
      const reads = /It reads like ([^,]*),/.exec(w.text);
      assert.ok(!reads || !reads[1].includes(tld), w.text);
    });
  }
});

// == F. look-alikes that today's checks miss ==

describe('look-alike review: hyphen, slash and dot look-alikes inside a name', () => {
  // The browser accepts these symbols in a name and turns the label into xn-- form. No check
  // looks at them: disguiseReasons() treats any non-ASCII label as an ordinary international
  // name and lookAlikeLetters() only counts Cyrillic and Greek letters, so the page says "No
  // warning signs found" for an address that reads exactly like a real one.
  for (const [input, what] of [
    [`https://www.norsk${u(0x2010)}tipping.no/`, 'U+2010 hyphen (Norsk Tipping is norsk-tipping.no)'],
    [`https://www.norsk${u(0x2011)}tipping.no/`, 'U+2011 non-breaking hyphen'],
    [`https://www.norsk${u(0x2013)}tipping.no/`, 'U+2013 en dash'],
    [`https://www.norsk${u(0x2212)}tipping.no/`, 'U+2212 minus sign'],
    [`https://www.seg${u(0x2010)}social.pt/`, 'U+2010 hyphen (Segurança Social is seg-social.pt)'],
  ]) {
    test(`F1 ${what} gets a Check note`, () => {
      const r = A(input);
      assert.ok(serious(r).length, `${input}: ${show(r)}`);
    });
  }

  for (const [cp, what] of [[0x2215, 'U+2215 division slash'], [0x2044, 'U+2044 fraction slash'], [0x29F8, 'U+29F8 big solidus']]) {
    test(`F2 a ${what} that makes the name read as paypal.com followed by a path gets a Check note`, () => {
      const r = A(`https://www.paypal.com${u(cp)}signin.evil.io/`);
      assert.ok(serious(r).length, show(r));
    });
  }

  test('F3 a middle dot that makes dnb.no.com read as two names gets a Check note', () => {
    const r = A('https://www.dnb·no.com/');
    assert.ok(serious(r).length, show(r));
  });

  // Guards for the fix: the same symbols are part of real names in other languages.
  test('a Catalan l·l (col·legi.cat) gets no Check note', () => assert.deepEqual(serious(A('https://col·legi.cat/')), []));
  test('a Japanese name with the long vowel mark (コーヒー.jp) gets no Check note', () => assert.deepEqual(serious(A('https://コーヒー.jp/')), []));
  test('a real hyphen (norsk-tipping.no) gets no Check note', () => assert.deepEqual(serious(A('https://www.norsk-tipping.no/')), []));
});

describe('look-alike review: whole names in Cyrillic letters the table does not list', () => {
  // Unicode confusables.txt 18.0.0 (scratchpad copy, sha256 6ed3ee96...) maps each of these
  // Cyrillic letters to a Latin one; LOOKS_LATIN in link-core.js lacks them, so a name made
  // only of Cyrillic letters is not flagged when one of them is used.
  for (const [host, reads, letter] of [
    ['ѵіѕа.com', 'visa.com', 'U+0475 izhitsa (v)'],
    ['огасӏе.com', 'oracle.com', 'U+0433 ghe (r)'],
    ['ԝіѡа.no', 'wiwa.no', 'U+0461 omega (w)'],
  ]) {
    test(`F4 ${host} (reads like ${reads}; ${letter}) gets the look-alike letters note`, () => {
      const r = A(`https://${host}/`);
      assert.ok(warning(r, 'look-alike-letters'), `${host}: ${show(r)}`);
    });
  }

  test('ѕһеӏӏ.com, made only of listed letters, is flagged today', () => assert.ok(warning(A('https://ѕһеӏӏ.com/'), 'look-alike-letters')));
});

describe('look-alike review: Latin names mixed with other alphabets', () => {
  // Spec warning 4 names Cyrillic and Greek. Armenian and Cherokee have letters that read
  // as Latin too (confusables.txt), and mixing them into a Latin name passes today.
  for (const [input, what] of [
    ['https://gօօgle.com/', 'Armenian օ (U+0585) in google.com'],
    ['https://ꮩipps.no/', 'Cherokee ꮩ (U+ABA9) in vipps.no'],
  ]) {
    test(`F5 ${what} gets a Check note`, () => {
      const r = A(input);
      assert.ok(serious(r).length, `${input}: ${show(r)}`);
    });
  }
});

// == L. likely findings: need Marcos's decision ==

describe('look-alike review: likely false alarms', () => {
  // Chromium shows a name written wholly in Cyrillic as it is when the ending is Cyrillic too
  // (.рф, .бг, .укр ...), and as xn-- under .com. CheckLink warns under both. Deciding this
  // the Chromium way would also silence аррӏе.рф; the brand list (stage 3) could catch that one.
  for (const host of ['сахар.рф', 'рус.рф']) {
    test(`L1 an ordinary Russian word under .рф (${host}) gets no look-alike note`, () => {
      const r = A(`https://${host}/`);
      assert.equal(warning(r, 'look-alike-letters'), undefined, show(r));
    });
  }

  test('L2 a Japanese name typed with the Japanese full stop (例え。jp) is not called disguised', () => {
    const r = A('https://例え。jp/');
    assert.equal(warning(r, 'disguised'), undefined, show(r));
  });

  test('L3 a Persian word with the zero-width non-joiner its spelling needs is not called disguised', () => {
    const r = A('https://می‌خواهم.ir/');
    assert.equal(warning(r, 'disguised'), undefined, show(r));
  });

  test('L4 an address hidden in ?next= that is written in look-alike letters is named as such on the first screen', () => {
    const r = A('https://example.com/login?next=https://аррӏе.com/');
    assert.ok(r.hidden[0].analysis.warnings.some((w) => w.id === 'look-alike-letters'), 'the hidden analysis has it today');
    assert.ok(r.warnings.some((w) => /Cyrillic|look like/.test(w.text)), show(r));
  });
});

// == S. brand look-alikes: stage 3, not built ==

describe('look-alike review: brand look-alikes', () => {
  for (const [input, brand, owner] of [
    // subdomain tricks
    ['https://paypal.com.evil.io/signin', 'PayPal', 'evil.io'],
    ['https://www.dnb.no.secure-login.ru/', 'DNB', 'secure-login.ru'],
    ['https://login.microsoftonline.com.auth-session.io/', 'Microsoft', 'auth-session.io'],
    ['https://appleid.apple.com.verify.top/', 'Apple', 'verify.top'],
    ['https://www.paypal.com.account.security.verify.session.id-48291.evil.io/', 'PayPal', 'evil.io'],
    // combosquats
    ['https://paypal-secure-login.com/', 'PayPal', 'paypal-secure-login.com'],
    ['https://dnb-sikkerhet.no/', 'DNB', 'dnb-sikkerhet.no'],
    ['https://vipps-refusjon.com/', 'Vipps', 'vipps-refusjon.com'],
    ['https://posten-pakke.com/', 'Posten', 'posten-pakke.com'],
    ['https://bankid-fornyelse.no/', 'BankID', 'bankid-fornyelse.no'],
    ['https://nav-utbetaling.com/', 'NAV', 'nav-utbetaling.com'],
    ['https://correios-rastreio.com/', 'Correios', 'correios-rastreio.com'],
    ['https://ctt-entregas.com/', 'CTT', 'ctt-entregas.com'],
    // hyphen tricks
    ['https://www-paypal.com/', 'PayPal', 'www-paypal.com'],
    ['https://pay-pal.com/', 'PayPal', 'pay-pal.com'],
    ['https://paypal-com.evil.io/', 'PayPal', 'evil.io'],
    ['https://paypal.com-account-verify.io/', 'PayPal', 'com-account-verify.io'],
    // letters and digits swapped
    ['https://paypa1.com/', 'PayPal', 'paypa1.com'],
    ['https://g00gle.com/', 'Google', 'g00gle.com'],
    ['https://rnicrosoft.com/', 'Microsoft', 'rnicrosoft.com'],
    ['https://www.p0sten.no/', 'Posten', 'p0sten.no'],
    // Latin look-alike letters and accents (one alphabet, so warning 4 cannot see them)
    ['https://ɡoogle.com/', 'Google', 'xn--oogle-qmc.com'],
    ['https://paypaǀ.com/', 'PayPal', 'xn--paypa-9tb.com'],
    ['https://pạypal.com/', 'PayPal', 'xn--pypal-j11b.com'],
    ['https://paypal̇.com/', 'PayPal', 'xn--paypal-uyd.com'],
    ['https://vípps.no/', 'Vipps', 'xn--vpps-vpa.no'],
    // free hosting (the spec's own example is the first)
    ['https://paypal.pages.dev/', 'PayPal', 'paypal.pages.dev'],
    ['https://vipps.netlify.app/', 'Vipps', 'vipps.netlify.app'],
    ['https://dnb-login.web.app/', 'DNB', 'dnb-login.web.app'],
    ['https://microsoft-login.github.io/', 'Microsoft', 'microsoft-login.github.io'],
    ['https://posten.firebaseapp.com/', 'Posten', 'posten.firebaseapp.com'],
  ]) {
    test(`S ${input} gets a Check note naming ${brand} and ${owner}`, () => {
      const r = A(input);
      assert.ok(brandNote(r, brand, owner), show(r));
    });
  }

  test('S the brand note and the @ note both show when a brand name sits before @ and the host is a subdomain trick', () => {
    const r = A('https://www.paypal.com@paypal.com.evil.io/');
    assert.ok(warning(r, 'at-trick'), 'the @ note shows today');
    assert.ok(brandNote(r, 'PayPal', 'evil.io'), show(r));
  });

  test('S removing the address disguise keeps the brand note, because the clean link still goes to the look-alike', () => {
    const r = A('https://www.dnb.no@dnb-sikkerhet.no/');
    assert.equal(r.cleanLink, 'https://dnb-sikkerhet.no/');
    assert.ok(brandNote(r, 'DNB', 'dnb-sikkerhet.no'), show(r));
  });

  test('S a look-alike behind a Google redirect gets the brand note for where it really goes', () => {
    const r = A('https://www.google.com/url?q=https://paypal.com.evil.io/&sa=D');
    assert.equal(r.host, 'paypal.com.evil.io');
    assert.ok(brandNote(r, 'PayPal', 'evil.io'), show(r));
  });

  test('S an ø standing in for o (pøsten.no) gets the brand note', () => {
    const r = A('https://pøsten.no/');
    assert.ok(brandNote(r, 'Posten', 'xn--psten-vua.no'), show(r));
  });
});

// == Guards: real addresses that must stay free of Check notes ==

const guards = {
  'real brand subdomains and country domains': [
    'https://www.paypal.com/no/home', 'https://www.paypalobjects.com/', 'https://mail.google.com/mail/u/0/',
    'https://accounts.google.com/signin', 'https://www.google.no/', 'https://www.google.com.br/', 'https://www.google.co.uk/',
    'https://login.microsoftonline.com/', 'https://outlook.live.com/mail/', 'https://apps.apple.com/no/', 'https://www.icloud.com/',
    'https://www.amazon.co.uk/', 'https://www.amazon.com.br/', 'https://www.ebay.co.uk/',
    'https://www.dnb.no/', 'https://www.vipps.no/', 'https://www.posten.no/', 'https://sporing.posten.no/', 'https://www.bring.no/',
    'https://www.bankid.no/', 'https://www.nav.no/', 'https://www.altinn.no/', 'https://www.skatteetaten.no/',
    'https://www.helsenorge.no/', 'https://www.skyss.no/', 'https://www.flysas.com/',
    'https://www.correios.com.br/', 'https://www.bb.com.br/', 'https://www.caixa.gov.br/', 'https://www.itau.com.br/',
    'https://www.cgd.pt/', 'https://www.ctt.pt/', 'https://www.portaldasfinancas.gov.pt/',
    'https://www.DNB.no./',
  ],
  'numbers and hyphens in real brand names': [
    'https://www.3m.com/', 'https://www.7-eleven.com/', 'https://www.o2.co.uk/', 'https://1password.com/',
    'https://www.sparebank1.no/', 'https://www.1881.no/', 'https://www.24sevenoffice.com/',
    'https://www.coca-cola.com/', 'https://www.t-mobile.com/', 'https://www.mercedes-benz.com/', 'https://www.rolls-royce.com/',
    'https://www.norsk-tipping.no/', 'https://www.seg-social.pt/',
  ],
  'ordinary words and other companies that contain a brand name': [
    // FINN in Finnair, Apple in AppleInsider (a third-party site) and Snapple, NAV in an
    // ordinary Norwegian word, SAS in Kansas, BB in BBC. A check that only asks "does the name
    // mention a brand" flags every one of these.
    'https://www.finnair.com/', 'https://appleinsider.com/', 'https://www.snapple.com/', 'https://www.navigasjon.no/',
    'https://www.kansas.gov/', 'https://www.bbc.co.uk/',
  ],
  'Norwegian, Portuguese and other names with their own letters': [
    'https://blåbær.no/', 'https://tromsø.no/', 'https://bærum.kommune.no/', 'https://ærø.dk/', 'https://øl.no/', 'https://ål.no/',
    'https://TROMSØ.NO/', 'https://BLÅBÆR.no/', `https://blåbær.no/`,
    'https://www.açores.pt/', 'https://maçã.pt/', 'https://pão.pt/', `https://pão.pt/`, 'https://AÇORES.PT/',
    'https://coração.com.br/', 'https://www.são-paulo.com.br/', 'https://ação.com.br/',
    'https://straße.de/', 'https://españa.es/', 'https://www.münchen.de/', 'https://ışık.com.tr/',
    'https://xn--blbr-roah.no/', 'https://www.xn--aores-yra.pt/',
  ],
  'other alphabets on their own': [
    'https://пример.рф/', 'https://ελλάδα.gr/', 'https://日本語.jp/', 'https://例え.jp/',
  ],
  'an @ that is not in the address part': [
    'https://www.youtube.com/@nrk', 'https://www.tiktok.com/@nrk', 'https://mastodon.social/@Gargron',
    'https://medium.com/@user/post-1', 'https://example.com/?email=ola@nordmann.no', 'https://www.paypal.com/#@evil.io',
  ],
};

describe('look-alike review: no Check note on real addresses', () => {
  for (const [group, list] of Object.entries(guards)) {
    test(group, () => {
      for (const input of list) {
        const r = A(input);
        assert.ok(r.found, `${input} is read as a link`);
        assert.deepEqual(serious(r), [], `${input}: ${show(r)}`);
      }
    });
  }
});
