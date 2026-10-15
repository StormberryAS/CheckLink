// Stage 4b, 11 October 2026: the rule and data items of the decisions of that day ("all as
// recommended") that do not wait for zxing-wasm 3.1.5. Run from the repository root with:
// node --test tests/
//
//   * L1: four GitHub Pages names the brands themselves hold (hosted in rules/brands.json), each
//     looked up online on 11 October 2026, to be checked again within a year;
//   * L2 and L3 (vv, cl and q as look-alike letters; seven lure words): the cases the decisions
//     named are in tests/lookalike-accuracy.test.mjs, now ordinary tests; this file guards
//     the names nearest to them, among them the two that the Tranco top-million run found;
//   * IG-1: every instagram.com rule also applies to instagr.am, by extension, not checked online;
//   * W-1: recovery phrases in the BIP-39 Japanese, Korean and Chinese lists and in all of
//     Monero's languages are recognised and hidden like the others;
//   * R-1: the search-engine research summaries are in rules/research/, recorded in the lock,
//     with private host names and personal details taken out.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyse } from '../src/link-core.js';
import { BRANDS, LURES, REAL_NAMES } from '../src/brands.js';
import { BIP39_ENGLISH } from '../src/bip39.js';
import { BIP39_LISTS, MONERO_ENGLISH, MONERO_LISTS, MONERO_PREFIX } from '../src/wordlists.js';
import { inspect } from '../src/qr-inspect.js';
import { checkAll as brandsCheck, readBrands, validate } from '../tools/brands.mjs';
import { checkAll as vendorCheck } from '../tools/vendor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const A = (input) => analyse(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}/`);
const LOOK = new Set(['look-alike-letters', 'look-alike-symbol', 'look-alike-brand', 'hidden-look-alike']);
const looks = (r) => r.warnings.filter((w) => LOOK.has(w.id));
const show = (r) => JSON.stringify(r.warnings.map((w) => `${w.id}/${w.tier}: ${w.text}`));
const value = (p, label) => (p.fields.find((f) => f.label === label) || {}).value;

// == L1 ==

describe('L1: GitHub Pages names that the brands themselves hold', () => {
  const HOSTED = { 'google.github.io': 'Google', 'microsoft.github.io': 'Microsoft', 'skatteetaten.github.io': 'Skatteetaten', 'metamask.github.io': 'MetaMask' };

  test('exactly the four checked names are listed, each with its account, check date, what was found, where, and a re-check within a year', () => {
    const data = readBrands();
    const listed = Object.fromEntries(data.brands.flatMap((b) => (b.hosted || []).map((h) => [h.name, b.name])));
    assert.deepEqual(listed, HOSTED);
    for (const b of data.brands) {
      for (const h of b.hosted || []) {
        assert.equal(h.checked, '2026-10-11', h.name);
        assert.equal(h.recheck_by, '2027-10-11', h.name);
        assert.ok(h.account && h.found && /github\.com/.test(h.source), h.name);
      }
    }
    assert.deepEqual(Object.fromEntries(BRANDS.flatMap((b) => (b.hosted || []).map((h) => [h, b.name]))), HOSTED);
  });

  test('the brand check passes today and refuses the list once a re-check date has passed', () => {
    assert.deepEqual(brandsCheck(new Date('2027-10-11T12:00:00Z')).errors, []);
    const late = brandsCheck(new Date('2027-10-12T00:00:00Z')).errors;
    assert.equal(late.length, 4, JSON.stringify(late));
    assert.ok(late.every((e) => /was due to be checked again by 2027-10-11/.test(e)));
  });

  test('the list refuses a hosted name that is not under a free hosting suffix, that belongs to two brands, or whose re-check is more than a year away', () => {
    const data = readBrands();
    const google = data.brands.find((b) => b.name === 'Google');
    const base = { ...google.hosted[0] };
    google.hosted = [{ ...base, name: 'google.de' }];
    assert.ok(validate(data).some((e) => /hosted google\.de is not a registrable domain .* PRIVATE section/.test(e)));
    google.hosted = [{ ...base, recheck_by: '2028-10-11' }];
    assert.ok(validate(data).some((e) => /recheck_by date at most a year later/.test(e)));
    google.hosted = [{ ...base, name: 'metamask.github.io' }];
    assert.ok(validate(data).some((e) => /metamask\.github\.io is listed for Google and MetaMask/.test(e)));
    google.hosted = [{ ...base, found: '' }];
    assert.ok(validate(data).some((e) => /needs the account that holds it/.test(e)));
  });

  test('every other name under github.io that mentions a brand still gets the note, and so do other free hosts', () => {
    for (const h of ['paypal.github.io', 'google-login.github.io', 'gooogle.github.io', 'microsoft-support.github.io', 'google.gitlab.io', 'skatteetaten.pages.dev']) {
      assert.ok(looks(A(h)).some((w) => w.tier === 'check'), `${h}: ${show(A(h))}`);
    }
  });

  test('a hosted name written into a longer address is still a look-alike (google.github.io.evil.io)', () => {
    assert.ok(looks(A('google.github.io.evil.io')).length, show(A('google.github.io.evil.io')));
  });

  test('a listed name keeps the plain note that anyone can make an address under github.io', () => {
    const r = A('https://google.github.io/styleguide/');
    assert.deepEqual(looks(r), []);
    assert.ok(r.warnings.some((w) => w.id === 'shared-domain' && w.tier === 'info'), show(r));
  });
});

// == L2 ==

describe('L2: vv, cl and q, read as w, d and g', () => {
  test('the note says which letters were put in', () => {
    for (const [host, detail] of [
      ['vvhatsapp.com', 'vv in place of the letter w'],
      ['cliscord.com', 'cl in place of the letter d'],
      ['gooqle.com', 'q in place of the letter g'],
      ['g00qle.com', 'the digit 0 in place of the letter o and q in place of the letter g'],
    ]) {
      assert.ok(looks(A(host)).some((w) => w.text.includes(`with ${detail}:`)), `${host}: ${show(A(host))}`);
    }
  });

  test('next to a lure word and written into a longer address, as the digits are', () => {
    for (const [host, brand] of [['vvhatsapp-login.com', 'WhatsApp'], ['gooqle.com.evil.io', 'Google'], ['cliscord-verify.com', 'Discord']]) {
      assert.ok(looks(A(host)).some((w) => w.text.includes(brand)), `${host}: ${show(A(host))}`);
    }
  });

  test('a mark that has cl itself is still found behind digits (1cloud.ru reads as icloud, as before)', () => {
    assert.ok(looks(A('1cloud.ru')).some((w) => /icloud\.com, with the digit 1 in place of the letter i/.test(w.text)), show(A('1cloud.ru')));
  });

  test('the Tranco run found two names that q makes look like gmail; both are real names (qmail, looked up online)', () => {
    assert.ok(REAL_NAMES.words.includes('qmail'));
    for (const h of ['qmail.org', 'qmail.com']) assert.deepEqual(looks(A(h)), [], h);
  });

  test('ordinary names with cl, q or vv in them stay clean', () => {
    for (const h of ['clinic.com', 'clickup.com', 'cloudflare.com', 'quora.com', 'qq.com', 'iqiyi.com', 'equinor.com', 'savvy.com', 'vvd.nl']) assert.deepEqual(looks(A(h)), [], h);
  });
});

// == L3 ==

describe('L3: the seven new lure words', () => {
  test('all seven are strong lure words, so they count for word marks too', () => {
    for (const w of ['renewal', 'shipment', 'findmy', 'minside', 'pakkesporing', 'auxilio', 'fgts']) assert.ok(LURES.strong.includes(w), w);
  });

  test('"skatt" is never a lure word or a mark: skatt.no is the taxpayers\' association, not Skatteetaten', () => {
    for (const list of Object.values(LURES)) assert.ok(!list.includes('skatt'));
    assert.ok(!BRANDS.some((b) => b.marks.some(([label]) => label === 'skatt')));
    for (const h of ['skatt.no', 'www.skatt.no']) assert.deepEqual(looks(A(h)), [], h);
  });

  test('the brands\' own pages with those words stay clean', () => {
    for (const h of ['minside.nav.no', 'fgts.caixa.gov.br', 'findmy.apple.com', 'www.posten.no', 'pakkesporing.no']) assert.deepEqual(looks(A(h)), [], h);
  });
});

// == IG-1 ==

describe('IG-1: every instagram.com rule also on instagr.am', () => {
  test('the igsh share ID goes on instagr.am, as on instagram.com', () => {
    const r = A('https://instagr.am/p/DABC123xyz/?igsh=MWx4dGZ3');
    assert.equal(r.cleanLink, 'https://instagr.am/p/DABC123xyz/');
    assert.equal(A('https://www.instagram.com/p/DABC123xyz/?igsh=MWx4dGZ3').cleanLink, 'https://www.instagram.com/p/DABC123xyz/');
  });

  test('an unknown parameter on an instagr.am post is shown as Unrecognised and removed by default, as on instagram.com', () => {
    for (const host of ['instagr.am', 'www.instagr.am', 'www.instagram.com']) {
      const r = A(`https://${host}/p/DABC123xyz/?zzq=1`);
      assert.equal(r.cleanLink, `https://${host}/p/DABC123xyz/`, host);
      assert.ok(r.parts.some((p) => p.name === 'zzq' && p.unrecognised), host);
    }
  });

  test('the two hosts clean every Instagram parameter the same way, and keep what the post needs', () => {
    const query = '?igsh=a&igshid=b&ig_rid=c&stkn=d&click_source=e&igsi=f&ndid=g&entry_point=h&ig_mid=i&short_redirect=j&helpref=k&source=l&campaign=m&medium=n&channel=o&content=p&mdxt=q&exln=r&img_index=2&hl=pt-br';
    for (const p of ['/p/DABC123xyz/', '/reel/DABC123xyz/']) {
      const big = A(`https://www.instagram.com${p}${query}`).cleanLink.replace('www.instagram.com', 'HOST');
      const short = A(`https://instagr.am${p}${query}`).cleanLink.replace('instagr.am', 'HOST');
      assert.equal(short, big);
      assert.equal(short, `https://HOST${p}?img_index=2&hl=pt-br`);
    }
  });

  test('a profile page is not a post, so an unknown parameter stays there on both hosts', () => {
    assert.equal(A('https://instagr.am/some.account/?zzq=1&igsh=a').cleanLink, 'https://instagr.am/some.account/?zzq=1');
  });

  test('the rules say they are by extension, not checked online', () => {
    const extra = JSON.parse(read('rules/extra-rules.json'));
    const blk = extra.additions.hosts.find((b) => b.pattern.length === 1 && b.pattern[0] === 'instagr.am');
    assert.equal(blk.params.length, 16);
    assert.ok(blk.params.every((p) => p.verified === false && /^By extension, not checked online/.test(p.basis)));
    const canon = extra.canonical.rules.find((c) => c.id === 'instagram-post');
    assert.ok(canon.hosts.includes('instagr.am') && canon.hosts.includes('www.instagr.am'));
    assert.match(canon.basis, /by extension, not checked online \(decision IG-1/);
  });
});

// == W-1 ==

// The BIP-39 checksum depends only on the words' positions, so an English test vector of BIP 39
// (trezor/python-mnemonic vectors.json) gives a valid phrase in every list at the same positions.
const VECTORS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
];
const at = (list, vector) => vector.split(' ').map((w) => list[BIP39_ENGLISH.indexOf(w)]);

describe('W-1: BIP-39 Japanese, Korean and Chinese', () => {
  test('the four lists are complete and in their own order', () => {
    for (const lang of ['japanese', 'korean', 'chinese_simplified', 'chinese_traditional']) assert.equal(BIP39_LISTS[lang].length, 2048, lang);
    assert.equal(BIP39_LISTS.japanese[0].normalize('NFC'), 'あいこくしん');
    assert.equal(BIP39_LISTS.chinese_simplified[0], '的');
  });

  test('Japanese, separated by the ideographic space (U+3000) as BIP 39 asks: the published vector for zero entropy', () => {
    const phrase = 'あいこくしん　あいこくしん　あいこくしん　あいこくしん　あいこくしん　あいこくしん　あいこくしん　あいこくしん　あいこくしん　あいこくしん　あいこくしん　あおぞら';
    const p = inspect(phrase);
    assert.equal(p.kind, 'secret');
    assert.equal(p.title, 'A wallet recovery phrase');
    assert.equal(value(p, 'Word list'), 'BIP-39, Japanese');
    assert.match(value(p, 'Checksum'), /pass the phrase/);
  });

  test('Japanese typed as people type it (composed letters, ordinary spaces) is recognised; a wrong last word does not pass', () => {
    for (const v of VECTORS) {
      const words = at(BIP39_LISTS.japanese, v).map((w) => w.normalize('NFC'));
      for (const sep of ['　', ' ']) {
        const p = inspect(words.join(sep));
        assert.equal(value(p, 'Word list'), 'BIP-39, Japanese', v);
        assert.match(value(p, 'Checksum'), /pass the phrase/, v);
      }
    }
    const bad = at(BIP39_LISTS.japanese, VECTORS[0]).slice(0, 11).concat(BIP39_LISTS.japanese[5]);
    assert.match(value(inspect(bad.join('　')), 'Checksum'), /does not pass/);
  });

  test('the two dots on a Japanese letter are not an accent: a word without them is a different word', () => {
    // がっこう (school, in the list) is not かっこう once its marks are taken off.
    const list = BIP39_LISTS.japanese.map((w) => w.normalize('NFC'));
    const voiced = list.find((w) => /[がざだば]/.test(w) && !list.includes(w.normalize('NFKD').replace(/[゙゚]/g, '').normalize('NFC')));
    assert.ok(voiced);
    const plain = voiced.normalize('NFKD').replace(/[゙゚]/g, '').normalize('NFC');
    const words = at(BIP39_LISTS.japanese, VECTORS[0]).map((w) => w.normalize('NFC'));
    words[4] = plain;
    assert.notEqual(inspect(words.join('　')).kind, 'secret');
  });

  test('Korean, typed as composed syllables', () => {
    for (const v of VECTORS) {
      const p = inspect(at(BIP39_LISTS.korean, v).map((w) => w.normalize('NFC')).join(' '));
      assert.equal(value(p, 'Word list'), 'BIP-39, Korean', v);
      assert.match(value(p, 'Checksum'), /pass the phrase/, v);
    }
  });

  test('Chinese, simplified and traditional, with spaces and without', () => {
    for (const [lang, name] of [['chinese_simplified', 'BIP-39, Chinese (simplified)'], ['chinese_traditional', 'BIP-39, Chinese (traditional)']]) {
      for (const v of VECTORS.slice(1)) {
        for (const sep of [' ', '']) {
          const p = inspect(at(BIP39_LISTS[lang], v).join(sep));
          assert.equal(value(p, 'Word list'), name, `${lang} ${JSON.stringify(sep)} ${v}`);
          assert.match(value(p, 'Checksum'), /pass the phrase/);
        }
      }
    }
    // Numbered, one character after each number.
    const numbered = at(BIP39_LISTS.chinese_simplified, VECTORS[1]).map((w, i) => `${i + 1}. ${w}`).join(' ');
    assert.equal(inspect(numbered).kind, 'secret');
  });

  test('ordinary Chinese text is written without spaces too, so without spaces a phrase counts only when its own check passes', () => {
    const words = at(BIP39_LISTS.chinese_simplified, VECTORS[1]);
    const wrong = words.slice(0, 11).concat(BIP39_LISTS.chinese_simplified[7]);
    assert.equal(inspect(wrong.join('')).kind, 'text');
    // With spaces, as wallets write it, a failing check is still hidden, as for every other list.
    const spaced = inspect(wrong.join(' '));
    assert.equal(spaced.kind, 'secret');
    assert.match(value(spaced, 'Checksum'), /does not pass/);
    for (const t of ['我们今天去公园玩然后回家', '欢迎光临，请出示您的会员卡。', '的一是在不了有和人这中大为上个国']) assert.equal(inspect(t).kind, 'text', t);
  });
});

describe('W-1: Monero in all of its languages', () => {
  test('thirteen lists of 1,626 words, each with the prefix length its checksum reads', () => {
    assert.equal(MONERO_ENGLISH.length, 1626);
    assert.deepEqual(Object.keys(MONERO_LISTS).sort(), ['chinese_simplified', 'dutch', 'english_old', 'esperanto', 'french', 'german', 'italian', 'japanese', 'lojban', 'portuguese', 'russian', 'spanish']);
    for (const [lang, words] of Object.entries(MONERO_LISTS)) assert.equal(words.length, 1626, lang);
    assert.deepEqual(MONERO_PREFIX, { english: 3, chinese_simplified: 1, dutch: 4, english_old: 4, esperanto: 4, french: 4, german: 4, italian: 4, japanese: 3, lojban: 4, portuguese: 4, russian: 4, spanish: 4 });
  });

  // Seeds from monero-ecosystem/monero-python tests/test_seed.py (BSD-3-Clause, at commit
  // 3f3a4cdc2a92a088172266d1916fbf2f59c23f2d), each checked there against its keys and address.
  const PYTHON = {
    'Chinese (simplified)': '遭 牲 本 点 司 司 仲 吉 虎 只 绝 生 指 纯 伟 破 夫 惊 群 楚 祥 旋 暗 骨 伟',
    Dutch: 'ralf tolvrij copier roon ossuarium wedstrijd splijt debbie bomtapijt occlusie oester noren hiaat scenario geshockt veeteler rotten symboliek jarig bock yoghurt plegen weert zeeblauw wedstrijd',
    Esperanto: 'knedi aspekti boli asbesto pterido aparta muro sandalo hufumo porcelana degeli utopia ebono lifto dutaga hundo vejno ebono higieno nikotino orkestro arlekeno insekto jaguaro hundo',
    French: 'sauce exprimer chasse asile larve tacler digestion muguet rondeur sept clore narrer fluor arme torse dans glace tant salon sanguin globe quiche ficher flaque clore',
    German: 'Erdgas Gesuch beeilen Chiffon Abendrot Alter Helium Salz Almweide Ampel Dichter Rotglut Dialekt Akkord Rampe Gesöff Ziege Boykott keuchen Krach Anbau Labor Esel Ferien Ampel',
    Italian: 'tramonto spuntare ruota afrodite binocolo riferire moneta assalire tuta firmare malattia flagello paradiso tacere sindrome spuntare sogliola volare follia versare insulto diagnosi lapide meteo malattia',
    Portuguese: 'rebuscar mefistofelico luto isca vulva ontologico autuar epiteto jarro invulneravel inquisitorial vietnamita voile potro mamute giroscopio scherzo cheroqui gueto loquaz fissurar fazer violoncelo viquingue vulva',
    Russian: 'дощатый ателье мыло паек азот ружье домашний уныние уплата торговля шкаф кекс газета тревога улица армия лазерный иголка друг хищник пашня дневник кричать лыжный иголка',
    Spanish: 'riesgo lápiz martes fuerza dinero pupila pago mensaje guion libro órgano juntar imperio puñal historia pasión nación posible paso límite don afirmar receta reposo fuerza',
  };

  test('published seeds in nine languages pass their own check and are hidden', () => {
    for (const [lang, seed] of Object.entries(PYTHON)) {
      const p = inspect(seed);
      assert.equal(p.kind, 'secret', lang);
      assert.equal(p.title, 'A Monero wallet recovery phrase', lang);
      assert.equal(value(p, 'Word list'), `Monero, ${lang}`, lang);
      assert.match(value(p, 'Checksum'), /pass the phrase/, lang);
      assert.match(p.warnings[0].text, /^Whoever has these words has the wallet/, lang);
    }
  });

  test('Chinese written without spaces is read one character per word', () => {
    const p = inspect(PYTHON['Chinese (simplified)'].replace(/ /g, ''));
    assert.equal(value(p, 'Word list'), 'Monero, Chinese (simplified)');
    assert.match(value(p, 'Checksum'), /pass the phrase/);
  });

  test('German nouns keep their capital letter in the list, and a seed is matched without regard to case (Monero\'s own test seeds)', () => {
    // monero-project/monero tests/unit_tests/mnemonics.cpp, case_tolerance and language detection.
    const seed = 'Neubau umarmen Abart umarmen Turban feilen Brett Bargeld Episode Milchkuh Substanz Jahr Armband Maibaum Tand Grünalge Tabak erziehen Federboa Lobrede Tenor Leuchter Curry Diskurs Tenor';
    for (const s of [seed, seed.toLowerCase()]) {
      const p = inspect(s);
      assert.equal(value(p, 'Word list'), 'Monero, German');
      assert.match(value(p, 'Checksum'), /pass the phrase/);
    }
    assert.match(value(inspect(seed.replace(/Tenor$/, 'Curry')), 'Checksum'), /does not pass/);
    const pt = 'cinzento luxuriante leonardo gnostico digressao cupula fifa broxar iniquo louvor ovario dorsal ideologo besuntar decurso rosto susto lemure unheiro pagodeiro nitroglicerina eclusa mazurca bigorna gnostico';
    assert.match(value(inspect(pt), 'Checksum'), /pass the phrase/);
  });

  test('Japanese: Monero reads the first 3 letters for its check (monero-python reads 4, so its Japanese seed does not pass here, but is hidden)', () => {
    const words = 'いもり すあな いきる しちょう うったえる ちひょう けなみ たいちょう うぶごえ しかい しなぎれ いっせい つかれる しなん ばあさん たいまつばな しひょう おいかける あんがい ていへん せんもん きこく せんく そそぐ'.split(' ');
    const python = inspect([...words, 'つかれる'].join(' '));
    assert.equal(value(python, 'Word list'), 'Monero, Japanese');
    assert.match(value(python, 'Checksum'), /does not pass/);
    // CRC-32 of the first three letters of the 24 words, modulo 24, picks そそぐ (the 24th word).
    const monero = inspect([...words, 'そそぐ'].join('　'));
    assert.equal(value(monero, 'Word list'), 'Monero, Japanese');
    assert.match(value(monero, 'Checksum'), /pass the phrase/);
  });

  test('Lojban (an apostrophe is a letter there) and the old English list: 24 words without a checksum word are still hidden', () => {
    const lojban = MONERO_LISTS.lojban.filter((w) => w.includes("'")).slice(0, 4).concat(MONERO_LISTS.lojban.slice(100, 120));
    assert.equal(lojban.length, 24);
    const p = inspect(lojban.join(' '));
    assert.equal(value(p, 'Word list'), 'Monero, Lojban');
    assert.match(value(p, 'Checksum'), /no checksum word/);
    const old = inspect(MONERO_LISTS.english_old.slice(700, 724).join(' '));
    assert.equal(value(old, 'Word list'), 'Monero, English (old)');
  });

  test('ordinary English text is still text, though the old English list holds common words', () => {
    for (const t of [
      'i just want to tell you that i love you more than anything in this world and i will never leave you alone again',
      'please remember to bring the red bag and the blue umbrella to the station at five because it will rain today',
    ]) assert.equal(inspect(t).kind, 'text', t);
  });
});

// == R-1 ==

describe('R-1: the search-engine research in rules/research/', () => {
  const lock = JSON.parse(read('tools/upstream.lock.json'));
  const files = lock.search_research_files.files;

  test('the eight summaries behind the 13 search-engine rules, recorded in the lock with both hashes and what was taken out', () => {
    assert.equal(files.length, 8);
    assert.deepEqual(readdirSync(path.join(ROOT, 'rules', 'research')).sort(), files.map((f) => path.basename(f.path)).sort());
    for (const f of files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.match(f.source_sha256, /^[0-9a-f]{64}$/);
      if (!f.redactions.length) assert.equal(f.sha256, f.source_sha256, f.path);
      JSON.parse(read(f.path));
    }
    assert.ok(files.reduce((n, f) => n + f.bytes, 0) < 500000);
    assert.deepEqual(vendorCheck({ release: false }).errors, []);
  });

  test('every summary the search-engine rules cite is there', () => {
    const extra = read('rules/extra-rules.json');
    const cited = new Set([...extra.matchAll(/\(([a-z-]+(?:\.verified)?\.json)[,)]/g)].map((m) => m[1]));
    assert.ok(cited.size >= 4, [...cited].join(' '));
    for (const name of cited) assert.ok(files.some((f) => f.path === `rules/research/${name}`), name);
  });

  test('nothing personal or private is left: no names, e-mail addresses, local paths, LAN addresses or private hosts', () => {
    for (const f of files) {
      const text = read(f.path);
      assert.doesNotMatch(text, /192\.168\.|povoa|stormberry|marcos|viking|protonvpn|authelia|searxngr6|\/home\/|\/tmp\/|\/mnt\/|@[a-z0-9-]+\.[a-z]{2,}/i, f.path);
    }
  });

  test('rules/ is not published with the website', () => {
    assert.match(read('_config.yml'), /^\s+- rules\/$/m);
  });
});
