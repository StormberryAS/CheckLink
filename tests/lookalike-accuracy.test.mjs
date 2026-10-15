// Look-alike accuracy review of stage 3 (src/lookalike.js, src/brands.js, src/confusables.js as
// link-core.js reports them), 11 October 2026. Run from the repository root with: node --test tests/
//
// Lens: make the look-alike checks wrong in both directions.
//   * False alarms: real names that get a Check look-alike note. Found by trying ordinary words,
//     national services and brand side domains, and by running lookAlike() over the Tranco top
//     million list of 10 October 2026 (459 names flagged; most are true typosquats, the ones below
//     are not). Every real name here was looked up online on 11 October 2026 (DNS, HTTPS, where
//     it lands and its page title); what was found is written next to it.
//   * Misses: addresses made to pass for a listed brand that get no note at all, so the page
//     says "No warning signs found". Cyrillic and Greek homographs, punycode input, the brand's
//     domain written at the start (paypal.com.evil.io) and the plain @ trick all held up; the
//     misses are in the joins (hyphens, dots, underscores, the last dot), typing slips inside
//     longer names, and characters from Japanese, Chinese and Korean that look like punctuation.
//
// Same convention as tests/adversarial.test.mjs: a test marked { todo: 'FPn ...' } (a false
// alarm) or { todo: 'FNn ...' } (a miss) fails today and documents a finding; node --test prints
// the failure as TODO without failing the suite. A test marked { todo: 'Ln ...' } fails today too,
// but whether CheckLink should change is Marcos's decision (the note says what is being decided).
// When a finding is fixed or decided, remove its marker. Tests without a marker pass today and
// guard the real names nearest to the fixes, so a fix does not swap a miss for a false alarm.
//
// FIXED 11 October 2026 (stage 3 fixes), so every FP and FN test is an ordinary test now:
//   * FP3: the brands' own domains joined rules/brands.json, each with a passing online record in
//     rules/brands-verified.json (node tools/brands.mjs --verify-missing); elkj\u00F8p.no answers
//     only over plain http, so it is a real name instead (below);
//   * FP1, FP2, FP4: real_names in rules/brands.json, each looked up online: ordinary words and
//     shared names one slip from a mark (correos, applied, tresor, vips, altin) are left alone by
//     the slip, digit and hyphen checks under any ending, and other organisations' domains
//     (d-nb.info, star-telegram.com, telenot.com ...) get no brand note;
//   * FN1 to FN9: src/lookalike.js (a word mark followed by the rest of its own domain, the domain
//     split across the last dot, a mark followed by a country ending, a lure in the next part, a
//     slip or digits inside a longer name next to a lure, the name split by hyphens next to a lure,
//     underscores and run-together joins before the registrable name, letters and a slip together,
//     and Japanese, Chinese and Korean characters that look like a hyphen, a slash or an l inside
//     an otherwise plain Latin name).
// The same run of the Tranco top million went from 459 names flagged to 420, and the one name
// newly flagged, login-gooogle.com, is a typosquat; office-com.jp, a Japanese office furniture
// shop the first try flagged, is a real name now.
//
// DECIDED 11 October 2026 (Marcos, "all as recommended"; built in stage 4b), so the L tests are
// ordinary tests too:
//   * L1: the four GitHub Pages names, each looked up online on 11 October 2026, are hosted names
//     of their brands in rules/brands.json, to be checked again within a year (recheck_by);
//   * L2: vv, cl and q count as w, d and g beside the digit table in src/lookalike.js;
//   * L3: the seven lure words are strong lure words in rules/brands.json; "skatt" is not one.
// Both L2 and L3 were accepted only after a run over the Tranco top million list (the same list
// of 10 October 2026) and the 27,881 real names added no false alarm.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { analyse } from '../src/link-core.js';

const A = (input) => analyse(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}/`);
const LOOK = new Set(['look-alike-letters', 'look-alike-symbol', 'look-alike-brand', 'hidden-look-alike']);
const looks = (r) => r.warnings.filter((w) => LOOK.has(w.id));
const show = (r) => JSON.stringify(r.warnings.map((w) => `${w.id}/${w.tier}: ${w.text}`));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A Check look-alike note that names the brand and, when given, the domain the address really
// belongs to as a whole name (evil.io inside paypal.com.evil.io does not count).
function names(r, brand, owner = null) {
  return r.warnings.find((w) => w.tier === 'check' && LOOK.has(w.id) && w.text.includes(brand)
    && (!owner || new RegExp(`(^|[^a-z0-9.\\-])${esc(owner)}([^a-z0-9-]|$)`, 'u').test(w.text)));
}
const seriousLook = (r) => r.warnings.find((w) => w.tier === 'check' && LOOK.has(w.id));

// == FP. false alarms on real names ==

describe('look-alike accuracy: false alarms', () => {
  // FP1. The typing-slip check (one letter left out, doubled, swapped or next to it on the
  // keyboard, from a distinct mark of five letters or more) lands on ordinary words in other
  // languages and on other organisations. Correos is the word for "post" in Spanish, and four
  // national posts use it; "applied" is an English word one swap from appleid; "trésor" is French
  // for treasury (and German for a safe).
  for (const [host, what] of [
    ['correos.es', 'Correos, the Spanish national post ("Localizar envíos, oficinas y códigos postales | Correos.es"); named as correios.com.br with a letter left out'],
    ['correos.cl', 'Correos de Chile, the Chilean national post ("Home - Correos")'],
    ['correos.go.cr', 'Correos de Costa Rica, the national post ("Inicio | Correos de Costa Rica")'],
    ['correos.gob.bo', 'the Bolivian national post, a government domain (resolves, HTTPS 200)'],
    ['applied.com', 'Applied Industrial Technologies; "applied" is named as appleid with two letters swapped'],
    ['tresor.gouv.ci', 'Direction générale du Trésor et de la Comptabilité publique, Côte d\'Ivoire; named as trezor.io with a neighbouring key'],
    ['www.vips.es', 'VIPS, the Spanish restaurant chain; named as vipps.no with a letter left out'],
    ['www.vips.com.mx', 'VIPS, the Mexican restaurant chain'],
    ['vips.edu', 'Vivekananda Institute of Professional Studies ("Vivekananda Institute of Professional Studies | Technical Campus")'],
    ['www.telenot.com', 'Telenot, German alarm systems ("Sicherheitslösungen und Alarmanlagen | TELENOT"); named as telenor.no with a neighbouring key'],
    ['tella.com', 'Tella, a screen recorder ("Tella | All-in-One Screen Recorder"); named as telia.no with an l in place of an i'],
    ['altin.in', 'Altin.in, Turkish gold prices ("altın" is Turkish for gold); named as altinn.no with a letter left out'],
    ['date.nager.at', 'Nager.Date, a public holiday service (lands on nagerholidays.com); named as naver.com with a neighbouring key'],
    ['mobilpay.ro', 'NETOPIA mobilPay, Romanian card payments (lands on netopia-payments.com); named as mobilepay.dk with a letter left out'],
    ['www.reddot.com.au', 'Red Dot, Australian discount shops ("Red Dot | Red Dot\'s the spot."); named as reddit.com with a neighbouring key'],
  ]) {
    test(`FP1 ${host} gets no look-alike note: ${what}`, () => {
      const r = A(host);
      assert.deepEqual(looks(r), [], show(r));
    });
  }

  // FP2. The hyphen and digit checks on short marks: a hyphen anywhere in d-nb makes it DNB's
  // name "with a hyphen put in", and "4u" (for you) makes it4u read as itau.
  for (const [host, what] of [
    ['d-nb.info', 'the Deutsche Nationalbibliothek\'s permanent links (lands on portal.dnb.de), linked from the authority data at the foot of Wikipedia articles; named as dnb.no with a hyphen put in'],
    ['it4u.net', 'IT4U Sweden AB, an IT supplier (lands on it4u.se); named as itau.com.br with the digit 4 in place of the letter a'],
  ]) {
    test(`FP2 ${host} gets no look-alike note: ${what}`, () => {
      const r = A(host);
      assert.deepEqual(looks(r), [], show(r));
    });
  }

  // FP3. The brand's own addresses that the list does not have. The build report knew two
  // (instagram-brand.com, linkedin-ei.com) and left them; there are many more, among them
  // Microsoft's sign-in, PayPal's newsroom and status page, Lounge by Zalando in Norway and the
  // brand's own name written with ø. Each was checked online the way rules/brands-verified.json
  // records its domains.
  for (const [input, what] of [
    ['telegra.ph', 'Telegraph, Telegram\'s publishing tool, served from Telegram\'s own addresses (149.154.164.13); named as telegram.org with a letter left out'],
    ['cdn4.cdn-telegram.org', 'Telegram\'s file server (149.154.164.24, lands on telegram.org)'],
    ['https://login.microsoftonline-p.com/', 'Microsoft sign-in (lands on login.microsoftonline.com, "Sign in to your account")'],
    ['c.s-microsoft.com', 'Microsoft\'s static files (lands on www.microsoft.com)'],
    ['cvws.icloud-content.com', 'iCloud Drive and Photos downloads (17.248.237.16, Apple\'s own address block)'],
    ['appleid.cdn-apple.com', 'Apple Account (lands on account.apple.com, "Manage your Apple Account")'],
    ['www.instagram-press.com', 'Instagram\'s press pages (lands on about.instagram.com/blog/)'],
    ['newsroom.paypal-corp.com', 'PayPal Newsroom ("PayPal Newsroom | Home")'],
    ['www.paypal-status.com', 'PayPal Status Page ("PayPal Status Page")'],
    ['static-eu.payments-amazon.com', 'Amazon Pay\'s checkout script (resolves, HTTPS 200)'],
    ['prod-static.disney-plus.net', 'Disney+ static files (resolves, HTTPS 200); named as disneyplus.com with a hyphen put in'],
    ['www.zalando-lounge.no', 'Lounge by Zalando in Norway ("Lounge by Zalando – nettoutlet for mote og hjem")'],
    ['www.zalando-lounge.de', 'Lounge by Zalando in Germany ("Lounge by Zalando – Online Outlet für Mode und Wohndesign")'],
    ['www.zalando-prive.it', 'Privé by Zalando in Italy ("Privé by Zalando: outlet online per la moda e la casa")'],
    ['www.ledgerwallet.com', 'Ledger\'s former address (lands on www.ledger.com)'],
    ['https://elkjøp.no/', 'Elkjøp\'s own name as it is spelt, xn--elkjp-yua.no, which sends you on to www.elkjop.no; the note says it is "made to look like elkjop.no, using letters that only look the same" while ending "Elkjøp\'s own address is elkjop.no"'],
  ]) {
    test(`FP3 ${input} gets no look-alike note: ${what}`, () => {
      const r = A(input);
      assert.deepEqual(looks(r), [], show(r));
    });
  }

  // FP4. A brand name next to an ordinary word: distinct marks join to any word with a hyphen,
  // word marks to a lure word (secure, recovery) with or without one.
  for (const [host, what] of [
    ['www.star-telegram.com', 'the Fort Worth Star-Telegram, a daily newspaper ("Fort Worth Breaking News & Sports | Fort Worth Star-Telegram")'],
    ['www.secure-hotel-booking.com', 'D-EDGE\'s hotel booking engine ("D-EDGE - secure-hotel-booking.com"), the booking page of many hotels; named as Booking.com'],
    ['securityledger.com', 'The Security Ledger, a security news site; named as Ledger'],
    ['www.officerecovery.com', 'OfficeRecovery, data recovery software ("Data Recovery Software for Windows and Mac"); named as Microsoft (office + recovery)'],
  ]) {
    test(`FP4 ${host} gets no look-alike note: ${what}`, () => {
      const r = A(host);
      assert.deepEqual(looks(r), [], show(r));
    });
  }
});

// == FN. misses: made to pass for a listed brand, and no note ==

describe('look-alike accuracy: misses', () => {
  // FN1. A hyphen in place of the dot, inside the registrable name. Caught in the part before it
  // (paypal-com.evil.io) and for distinct marks (paypal-com.net), but for a word mark (DNB, NAV,
  // Posten, Amazon, Apple) the "com" or "no" after the hyphen is not a lure word, so nothing is
  // said. The same address behind the @ trick, and hidden inside another link, gets no brand note
  // either.
  for (const [input, brand, owner] of [
    ['dnb-no.com', 'DNB', 'dnb-no.com'],
    ['nav-no.net', 'NAV', 'nav-no.net'],
    ['posten-no.info', 'Posten', 'posten-no.info'],
    ['amazon-com.net', 'Amazon', 'amazon-com.net'],
    ['apple-com.info', 'Apple', 'apple-com.info'],
    ['www-dnb-no.com', 'DNB', 'www-dnb-no.com'],
    ['https://www.dnb.no@dnb-no.com/', 'DNB', 'dnb-no.com'],
    ['https://www.google.com/url?q=https://dnb-no.com/&sa=D', 'DNB', 'dnb-no.com'],
  ]) {
    test(`FN1 ${input} names ${brand} and ${owner}`, () => {
      const r = A(input);
      assert.ok(names(r, brand, owner), show(r));
    });
  }

  // FN2. The brand's domain split across the last dot: www.dnb.no-sikkerhet.com reads as
  // www.dnb.no followed by more, but it belongs to no-sikkerhet.com. The "written" check only
  // looks inside the part before the registrable name, and the "mentions" check needs a distinct
  // mark or a lure in the same label, so word marks pass. paypal.com-account-verify.io is caught
  // only because PayPal is a distinct mark.
  for (const [input, brand, owner] of [
    ['www.dnb.no-sikkerhet.com', 'DNB', 'no-sikkerhet.com'],
    ['nav.no-utbetaling.com', 'NAV', 'no-utbetaling.com'],
    ['posten.no-toll.com', 'Posten', 'no-toll.com'],
    ['apple.com-id.info', 'Apple', 'com-id.info'],
    ['www.amazon.com-orders.top', 'Amazon', 'com-orders.top'],
    ['https://posten.no:443@posten.no-toll.com/', 'Posten', 'no-toll.com'],
  ]) {
    test(`FN2 ${input} names ${brand} and ${owner}`, () => {
      const r = A(input);
      assert.ok(names(r, brand, owner), show(r));
    });
  }

  test('FN2 the same split address hidden in next= is said on the first screen', () => {
    const r = A('https://example.com/login?next=https://www.dnb.no-sikkerhet.com/');
    const w = r.warnings.find((x) => x.id === 'hidden-look-alike');
    assert.ok(w && w.tier === 'check' && w.text.includes('DNB'), show(r));
  });

  // FN3. A brand's own country domain written into a longer address. amazon.co.uk and amazon.de
  // are treated as Amazon's own (the exact-name rule), but only the domains on the list count as
  // "written", and amazon alone is a word mark, so nothing is said.
  for (const [input, owner] of [
    ['www.amazon.co.uk.evil.io', 'evil.io'],
    ['www.amazon.de.evil.io', 'evil.io'],
    ['https://www.amazon.co.uk@amazon.co.uk.evil.io/', 'evil.io'],
  ]) {
    test(`FN3 ${input} names Amazon and ${owner}`, () => {
      const r = A(input);
      assert.ok(names(r, 'Amazon', owner), show(r));
    });
  }

  // FN4. A word mark and a lure word in neighbouring labels: amazon-signin.evil.io is caught,
  // amazon.signin.evil.io is not, because the lure has to be in the same label.
  for (const [input, brand, owner] of [
    ['amazon.signin.evil.io', 'Amazon', 'evil.io'],
    ['dnb.sikkerhet.evil.io', 'DNB', 'evil.io'],
  ]) {
    test(`FN4 ${input} names ${brand} and ${owner}`, () => {
      const r = A(input);
      assert.ok(names(r, brand, owner), show(r));
    });
  }

  // FN5. A typing slip or a digit inside a longer name. paypall.com, facebok.com, vipp5.no and
  // b4nkid.no are each named; joined to a lure word, or written before another domain, they are
  // not, because the slip and digit checks look only at the whole registrable label.
  for (const [input, brand, owner] of [
    ['paypall-login.com', 'PayPal', 'paypall-login.com'],
    ['facebok-login.com', 'Facebook', 'facebok-login.com'],
    ['gooogle-verify.com', 'Google', 'gooogle-verify.com'],
    ['vipp5-refusjon.com', 'Vipps', 'vipp5-refusjon.com'],
    ['n3tflix-billing.com', 'Netflix', 'n3tflix-billing.com'],
    ['b4nkid-fornyelse.no', 'BankID', 'b4nkid-fornyelse.no'],
    ['gooogle.com.evil.io', 'Google', 'evil.io'],
  ]) {
    test(`FN5 ${input} names ${brand} and ${owner}`, () => {
      const r = A(input);
      assert.ok(names(r, brand, owner), show(r));
    });
  }

  // FN6. The brand's name split by a hyphen and joined to more: pay-pal.com is caught (the
  // hyphens are taken out of the whole label), pay-pal-login.com is not (the tokens pay and pal
  // are compared one by one, and the label without hyphens is paypallogin).
  for (const [input, brand, owner] of [
    ['pay-pal-login.com', 'PayPal', 'pay-pal-login.com'],
    ['face-book-login.com', 'Facebook', 'face-book-login.com'],
    ['net-flix-billing.com', 'Netflix', 'net-flix-billing.com'],
    ['pay-pal.com.evil.io', 'PayPal', 'evil.io'],
  ]) {
    test(`FN6 ${input} names ${brand} and ${owner}`, () => {
      const r = A(input);
      assert.ok(names(r, brand, owner), show(r));
    });
  }

  // FN7. Joins the part before the registrable name does not split on: a lure word or the ending
  // run together with the brand (paypallogin.com is caught, paypallogin.evil.io is not), and an
  // underscore, which the browser accepts in a name and DNS serves.
  for (const [input, owner] of [
    ['paypallogin.evil.io', 'evil.io'],
    ['paypalcom.evil.io', 'evil.io'],
    ['paypal_login.evil.io', 'evil.io'],
    ['www.paypal_com.evil.io', 'evil.io'],
  ]) {
    test(`FN7 ${input} names PayPal and ${owner}`, () => {
      const r = A(input);
      assert.ok(names(r, 'PayPal', owner), show(r));
    });
  }

  // FN8. Look-alike letters and a typing slip together. paypai.com is named (an i for a small l);
  // the same name with the Turkish dotless i or the Latin iota gets nothing at all, because the
  // slip check skips international names and the letters check sees only Latin letters. In
  // Cyrillic under .rf, paypall gets nothing either: a whole-Cyrillic name is ordinary there
  // unless it passes for a brand exactly.
  for (const [input, brand, own] of [
    ['https://paypaı.com/', 'PayPal', 'paypal.com'],
    ['https://xn--paypa-r4a.com/', 'PayPal', 'paypal.com'],
    ['https://paypaɩ.com/', 'PayPal', 'paypal.com'],
    ['https://раураӏӏ.рф/', 'PayPal', 'paypal.com'],
  ]) {
    test(`FN8 ${input} names ${brand} (${own})`, () => {
      const r = A(input);
      assert.ok(names(r, brand, own), show(r));
    });
  }

  // FN9. Characters from Japanese, Chinese and Korean that look like punctuation inside a Latin
  // name. Mixing Latin with these alphabets is allowed (Japanese names do it), and Firefox shows
  // such names as written. Two reasons they pass:
  //   * the katakana no (U+30CE) looks like a slash and U+4E36 like a backslash, and the vendored
  //     table says so, but symbolFinding() skips every letter before it reads the table;
  //   * the long-dash family (U+30FC, U+4E00, U+3161 which the browser writes as U+1173) and the
  //     upright-line family (U+4E28, U+3163 written as U+1175) have non-ASCII prototypes in
  //     Unicode's confusables.txt (U+30FC and U+4E28), so the ASCII subset leaves them out.
  for (const [input, what, brand] of [
    ['https://www.dnb.noノlogin.evil.io/', 'reads like www.dnb.no/login.evil.io (katakana no)', null],
    ['https://www.dnb.xn--nologin-u04f.evil.io/', 'the same address in the browser\'s form', null],
    ['https://www.paypal丶com.evil.io/', 'reads like www.paypal.com.evil.io (U+4E36, which the table maps to a backslash)', null],
    ['https://www.norskーtipping.no/', 'reads like www.norsk-tipping.no (prolonged sound mark)', 'Norsk Tipping'],
    ['https://seg一social.pt/', 'reads like seg-social.pt (the Chinese one)', 'Segurança Social'],
    ['https://norskㅡtipping.no/', 'reads like norsk-tipping.no (Hangul eu)', 'Norsk Tipping'],
    ['https://paypa丨.com/', 'reads like paypal.com (the Chinese upright line)', 'PayPal'],
    ['https://paypaㅣ.com/', 'reads like paypal.com (Hangul i)', 'PayPal'],
  ]) {
    test(`FN9 ${input} gets a Check look-alike note: ${what}`, () => {
      const r = A(input);
      assert.ok(brand ? names(r, brand) : seriousLook(r), show(r));
    });
  }
});

// == L. for Marcos to decide ==

describe('look-alike accuracy: decided by Marcos (L1 to L3)', () => {
  // L1. Free hosting names that the brand itself holds. A GitHub Pages name belongs to the GitHub
  // account of that name, so it is the brand's for as long as the account is; a name freed by a
  // rename or a deleted account can be claimed by someone else, hence the yearly check. Decided:
  // list each checked name as the brand's own (hosted in rules/brands.json).
  for (const [host, brand, what] of [
    ['google.github.io', 'Google', 'redirects to github.com/google'],
    ['microsoft.github.io', 'Microsoft', '"Microsoft on GitHub"'],
    ['skatteetaten.github.io', 'Skatteetaten', '"Skatteetaten.github.io", the tax agency\'s API documentation'],
    ['metamask.github.io', 'MetaMask', '"The Ultimate Crypto Wallet for DeFi, Web3 Apps, and NFTs | MetaMask"'],
  ]) {
    test(`L1 ${host} (${brand}: ${what}) gets no look-alike note`, () => {
      const r = A(host);
      assert.deepEqual(looks(r), [], show(r));
    });
  }

  // L2. ASCII look-alikes outside Unicode's table: vv for w, q for g, cl for d. confusables.txt
  // pairs only m with rn among small letters; typosquat tools (dnstwist's homoglyph list) try
  // these too. Decided: add them beside the digit table.
  for (const [host, brand] of [
    ['vvhatsapp.com', 'WhatsApp'],
    ['tvvitter.com', 'X (Twitter)'],
    ['gooqle.com', 'Google'],
    ['linkeclin.com', 'LinkedIn'],
    ['cliscord.com', 'Discord'],
  ]) {
    test(`L2 ${host} names ${brand}`, () => {
      const r = A(host);
      assert.ok(names(r, brand, host), show(r));
    });
  }

  // L3. Lure words the list lacks, for word marks (which need one): renewal and shipment, the
  // Norwegian minside (the "Min side" login of NAV and the banks) and pakkesporing, Brazil's
  // auxilio and FGTS (benefit and pension-fund lures for Caixa), and Apple's Find My. Decided: add
  // all seven; skatt.no below is why "skatt" itself must never become a Skatteetaten word.
  for (const [host, brand] of [
    ['amazon-prime-renewal.com', 'Amazon'],
    ['dhl-shipment.com', 'DHL'],
    ['nav-minside.com', 'NAV'],
    ['dnb-minside.no', 'DNB'],
    ['posten-pakkesporing.no', 'Posten'],
    ['caixa-auxilio.com', 'Caixa'],
    ['caixa-fgts.com', 'Caixa'],
    ['apple-findmy.com', 'Apple'],
  ]) {
    test(`L3 ${host} names ${brand}`, () => {
      const r = A(host);
      assert.ok(names(r, brand, host), show(r));
    });
  }
});

// == G. guards: real names nearest to the fixes, clean today ==

describe('look-alike accuracy: guards that pass today', () => {
  test('the Deutsche Nationalbibliothek\'s main address stays clean (www.dnb.de, "DNB - Startseite"), whatever is done about d-nb.info', () => {
    for (const h of ['dnb.de', 'www.dnb.de', 'portal.dnb.de']) assert.deepEqual(looks(A(h)), [], h);
  });

  test('skatt.no is the taxpayers\' association Skattebetalerforeningen, not Skatteetaten: no note', () => {
    assert.deepEqual(looks(A('www.skatt.no')), []);
  });

  test('brand names under endings one slip from .com that the brands hold stay clean (each lands on the brand, checked 2026-10-11)', () => {
    for (const h of ['paypal.co', 'netflix.om', 'google.cm']) assert.deepEqual(looks(A(h)), [], h);
  });

  test('brand side domains joined to an ordinary word stay clean (apple-cloudkit.com on Apple\'s 17.0.0.0/8, ssl-images-amazon.com behind m.media-amazon.com)', () => {
    for (const h of ['www.apple-cloudkit.com', 'images-na.ssl-images-amazon.com']) assert.deepEqual(looks(A(h)), [], h);
  });

  test('the long vowel mark and the Chinese one between Japanese characters are spelling: no note', () => {
    for (const h of ['コーヒー.jp', 'ラーメン.jp', '第一.jp']) assert.deepEqual(looks(A(h)), [], h);
  });

  test('what held up: homographs, punycode input, the brand\'s domain written at the start, and the plain @ trick', () => {
    for (const [input, brand] of [
      ['https://раураӏ.com/', 'PayPal'],
      ['https://ρауρаӏ.com/', 'PayPal'],
      ['https://XN--PYPAL-4VE.COM/', 'PayPal'],
      ['https://paypal.cоm.evil.io/', 'PayPal'],
      ['https://amazon.com.br.evil.io/', 'Amazon'],
      ['https://portaldasfinancas.gov.pt.evil.io/', 'Portal das Finanças'],
      ['https://paypa1.com.evil.io/', 'PayPal'],
      ['https://www.paypal.com@xn--pypal-4ve.com/', 'PayPal'],
    ]) {
      const r = A(input);
      assert.ok(seriousLook(r) && (names(r, brand) || r.warnings.some((w) => w.id === 'look-alike-letters')), `${input}: ${show(r)}`);
    }
  });
});
