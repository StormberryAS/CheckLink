// The fixer pass of batch 3 (10 October 2026): engine-side tests for the interface review's
// findings and the guards around the accuracy and security fixes. The accuracy and security
// findings themselves are tested in tests/batch3-review.test.mjs and
// tests/batch3-security.test.mjs (their todo markers removed); what only the page shows is
// tested in tests/ui-smoke.mjs and tests/e2e.mjs. Run from the repository root with:
// node --test tests/
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { analyse, reportMail } from '../src/link-core.js';
import { RULES } from '../src/rules.js';
import { rowLabel, sameKind, whoFor } from '../src/row-words.js';

const A = (s) => analyse(s);
const part = (r, name) => r.parts.find((p) => p.name === name);
const warning = (r, id) => r.warnings.find((w) => w.id === id);

describe('the part before @ says what it is (interface finding 5, security F7 and F10)', () => {
  test('a user name and password: "Sign-in details in the address", never "look like admin"', () => {
    const r = A('https://admin:hunter2@login.example.com/');
    const u = part(r, 'Sign-in details in the address');
    assert.ok(u && u.where === 'userinfo' && u.disguise === 'sign-in' && u.defaultRemove && u.tier === 'check');
    assert.equal(u.reveals, 'A user name and password written into the address. Anyone who gets the link can read them. Untick it only if this site needs them to let you in.');
    assert.ok(!u.reveals.includes('hunter2'));
    // Stage 2: warnings lead with the registrable domain (the Public Suffix List).
    assert.equal(warning(r, 'at-trick').text, 'Sign-in details are written into this address, before the @. Anyone who gets the link can read them. It goes to example.com (full name: login.example.com).');
    assert.equal(r.cleanLink, 'https://login.example.com/');
  });

  test('a user name alone, and an email address as the user name, are sign-in details too', () => {
    assert.equal(A('https://john@example.com/').parts[0].reveals, 'A user name written into the address. Anyone who gets the link can read it. Untick it only if this site needs it to let you in.');
    assert.equal(A('https://jane.doe%40gmail.com@files.example.com/').parts[0].disguise, 'sign-in');
  });

  test("a name that reads as a host stays an address disguise, in Marcos's words (decision 11)", () => {
    const r = A('http://convincing-business-related-page-name-pretending-to-be-on-google.com@kaspersky.com/blog/');
    assert.equal(r.parts[0].disguise, 'look-alike');
    assert.equal(r.parts[0].name, 'Address disguise');
    assert.equal(warning(r, 'at-trick').text, 'This address is made to look like a different site. It goes to kaspersky.com: make sure that is the site you expected.');
    assert.equal(A('https://www.paypal.com:secure@evil.example/').parts[0].disguise, 'look-alike', 'a password after a host-like name is still a disguise');
  });

  test('a backslash disguise names the host a person reads, and says the clean link still shows it', () => {
    const p = A('https://user@evil.example\\@www.google.com/').parts[0];
    assert.equal(p.disguise, 'backslash');
    assert.equal(p.reveals, 'Everything before @ is not where this goes. The address is made to read as www.google.com, but a backslash cuts it short: the link goes to evil.example. The clean link still shows www.google.com after the backslash.');
  });

  test('without a row (a link left untouched) the warning keeps the spec wording', () => {
    assert.equal(warning(A('https://user@example.com/reset?token=abc123'), 'at-trick').text, 'The part before @ is not where this goes. It goes to example.com.');
  });

  test('the look-alike text keeps spaces, line breaks and quotes written as %XX, so it cannot read as a sentence', () => {
    const p = A('https://a%22b%20c%0Ad@evil.example/').parts[0];
    assert.equal(p.value, 'a%22b%20c%0Ad');
    assert.ok(!/[\s"]/.test(p.value));
  });
});

describe('look-alike letters (spec warning 4, security F9)', () => {
  // Since stage 3 (11 October 2026) the note shows the address as a person reads it and then in
  // the browser's xn-- form (look-alike review P1), and names the brand when it passes for a
  // listed one (src/brands.js). Since the stage 3 fixes the letters from another alphabet are
  // named in brackets, so the address in the note never looks exactly like the real one
  // (interface review M1), and the note starts "This address" like the others.
  for (const [host, marked, lead, reads, brand] of [
    ['g\u043E\u043Egle.com', 'g[Cyrillic \u043E\u043E]gle.com', 'This address has', 'google.com', ['Google', 'google.com']],
    ['\u0430\u0440\u0440\u04CF\u0435.com', '[Cyrillic \u0430\u0440\u0440\u04CF\u0435].com', 'This address is written in', 'apple.com', ['Apple', 'apple.com']],
    ['\u0441\u043E\u0441\u043E.com', '[Cyrillic \u0441\u043E\u0441\u043E].com', 'This address is written in', 'coco.com', null],
  ]) {
    test(`${host} gets a Check note that names what it reads like and its real form`, () => {
      const r = A(`https://${host}/`);
      const w = warning(r, 'look-alike-letters');
      assert.equal(w.tier, 'check');
      const tail = brand ? ` It is made to look like ${brand[0]}'s own address, ${brand[1]}.` : '';
      assert.equal(w.text, `${lead} Cyrillic letters that look like Latin ones. It reads like ${reads}, but it is a different address: ${marked} (in the browser's form, ${r.host}).${tail}`);
      assert.ok(r.host.startsWith('xn--'));
    });
  }

  test('Greek letters mixed with Latin are named as Greek', () => {
    assert.match(warning(A('https://g\u03BF\u03BFgle.com/'), 'look-alike-letters').text, /^This address has Greek letters that look like Latin ones\./);
  });

  test('written as xn-- the note still shows', () => {
    assert.ok(warning(A('https://xn--pypal-4ve.com/'), 'look-alike-letters'));
  });

  for (const host of ['blåbær.no', 'münchen.de', '\u043F\u0440\u0438\u043C\u0435\u0440.\u0440\u0444', '\u03B5\u03BB\u03BB\u03AC\u03B4\u03B1.gr', '日本語.jp', 'example.com', 'xn--p1ai']) {
    test(`no note for ${host}: Norwegian letters, other alphabets on their own and plain names never count`, () => {
      assert.equal(warning(A(`https://${host}/`), 'look-alike-letters'), undefined);
    });
  }
});

describe('badges follow what the value is (interface finding 7)', () => {
  test('an ID for one search is unique to the click, whatever its shape', () => {
    assert.equal(part(A('https://search.naver.com/search.naver?query=bergen&tqi=abc'), 'tqi').unique, true);
    assert.equal(part(A('https://www.startpage.com/sp/search?query=bergen&sc=abc'), 'sc').unique, true);
    assert.equal(part(A('https://yandex.ru/search/?text=bergen&parent-reqid=1'), 'parent-reqid').unique, true);
  });

  test('a setting is the same for everyone, however random its value looks', () => {
    const r = A('https://www.mojeek.com/search?q=bergen&qss[]=DuckDuckGo&qss[]=Brave&theme=dK3x9QpZ7wR2mT5vB8nY');
    for (const p of r.parts) assert.equal(p.unique, false, p.name);
    assert.equal(part(A('https://www.google.com/search?q=bergen&authuser=3'), 'authuser').unique, false);
  });

  test('a short value made of letters only is a word, not an ID', () => {
    const r = A('https://www.instagram.com/p/DABC123xyz/?zzq=HackerNews');
    assert.equal(part(r, 'zzq').unique, false);
    assert.equal(part(A('https://www.instagram.com/p/DABC123xyz/?zzq=Ab3dE5gH7jK9mN1pQ3'), 'zzq').unique, true);
  });

  test('the build writes perClick true or false only where an entry or its words say so', () => {
    const google = RULES.canonical.find((c) => c.id === 'google-search');
    assert.equal(google.remove.find((e) => e.names.includes('authuser')).perClick, false);
    assert.equal(google.remove.find((e) => e.names.includes('ei')).perClick, true);
    assert.equal(google.remove.find((e) => e.names.includes('oq')).perClick, undefined);
  });
});

describe('rows that would say less (interface findings 6, 8 and 9)', () => {
  test('an empty pair a page rule drops is marked empty, with plain words', () => {
    const p = part(A('https://search.naver.com/search.naver?query=bergen&nso='), 'nso');
    assert.equal(p.empty, true);
    assert.equal(p.reveals, 'It holds nothing, so the page opens the same without it.');
  });

  test('the label drops the name "Who learns it" gives, and a "Search" after it', () => {
    const r = A('https://www.google.com/search?q=bergen&sca_esv=abc123&oq=bergen&biw=1536');
    assert.equal(whoFor(part(r, 'sca_esv')), 'Google');
    assert.equal(rowLabel(part(r, 'sca_esv')), 'Session value');
    assert.equal(rowLabel(part(r, 'oq')), 'Typed query');
    assert.equal(rowLabel(part(A('https://youtu.be/WgewEn1mFPs?si=x7DG-_JN6QGh1mJr'), 'si')), 'Share ID');
    assert.equal(rowLabel(part(A('https://www.google.com/search?q=x&zzq=1'), 'zzq')), '', 'a label that is only the platform goes (Google Search under Google)');
    assert.equal(rowLabel(part(A('https://www.instagram.com/p/DeTqc0NDifd/?zzq=1'), 'zzq')), 'Instagram', 'Instagram under Meta stays');
    assert.equal(rowLabel(part(A('https://www.instagram.com/p/DeTqc0NDifd/?mdxt=x'), 'mdxt')), 'Instagram sharer ID', 'a label that does not start with the name stays');
    assert.equal(rowLabel({ provider: 'Xandr click ID', family: 'X (Twitter)' }), 'Xandr click ID', 'a name is only dropped as a whole word');
  });

  test('a run of rows with the same label and explanation folds, but never a wrapper, a disguise or an empty part', () => {
    const r = A('https://www.baidu.com/s?wd=bergen&rsv_spt=1&rsv_iqid=0x1&rsv_bp=1&rsv_t=abc');
    assert.deepEqual(r.parts.map((p, i) => sameKind(r.parts[i - 1], p)), [false, true, true, true]);
    const n = A('https://search.naver.com/search.naver?query=bergen&nso=&ssc=');
    assert.deepEqual(n.parts.map((p, i) => sameKind(n.parts[i - 1], p)), [false, false]);
  });

  test('kept parts carry what they do without "It does not identify you", so a page can say it once', () => {
    const r = A('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123&index=2&t=30');
    assert.ok(r.kept.length === 4 && r.kept.every((k) => k.neutral && k.explain === `${k.what} It does not identify you.`));
    const q = A('https://www.google.com/search?q=bergen').kept[0];
    assert.equal(q.what, q.explain);
  });

  test('prmd, stick, rdr and rdrig each get one sentence instead of the whole list', () => {
    const g = A('https://www.google.com/search?q=x&prmd=ivn&stick=H4sI');
    for (const name of ['prmd', 'stick']) assert.equal(g.kept.find((k) => k.name === name).explain, 'Google uses it to lay out this results page; removing it was reported to break the page.');
    const b = A('https://www.bing.com/search?q=x&rdr=1&rdrig=ABC');
    for (const name of ['rdr', 'rdrig']) assert.equal(b.kept.find((k) => k.name === name).explain, 'Bing uses it on this results page; removing it was reported to break the page.');
  });
});

describe('wording the rows show (interface findings 6 and 12)', () => {
  test('no research citation in a verified rule the search rows show', () => {
    const r = A('https://www.google.com/search?q=x&sca_esv=a&source=hp');
    assert.equal(part(r, 'sca_esv').reveals, 'A session or test value Google adds to searches; the results are the same without it.');
    assert.equal(part(r, 'source').reveals, 'Where on Google the search was started, such as the home page (hp), a results page (serp) or Image Search (img).');
    const b = A('https://www.bing.com/search?q=x&pq=x&ts=1644819994709&form=QBLH');
    assert.equal(part(b, 'pq').reveals, 'A copy of the search words as they were typed into the search box.');
    assert.equal(part(b, 'ts').reveals, 'When the search link was made, to the millisecond.');
    assert.equal(part(b, 'form').reveals, 'Which box, button or partner the search came from (for example QBLH or ANNTA1); Microsoft Rewards uses it too.');
  });

  test('one point of view: "your", never "the sharer\'s", in the page rules and path rules', () => {
    const texts = [...RULES.canonical.flatMap((c) => (c.remove || []).map((e) => e.reveals)), ...RULES.pathRules.map((p) => p.reveals)];
    assert.deepEqual(texts.filter((t) => /\bsharer\b/.test(t)), []);
  });

  test('partner codes say "so it can be paid", not "so the partner can be paid"', () => {
    const texts = RULES.canonical.flatMap((c) => (c.remove || []).map((e) => e.reveals));
    assert.deepEqual(texts.filter((t) => /the partner can be paid/.test(t)), []);
    assert.equal(part(A('https://search.brave.com/search?q=x&source=web'), 'source').reveals, 'Which page or app the search started from (web, desktop, Android, iOS, new tab).');
  });
});

describe('addresses the page needs, and the Maps note (interface findings 11 and 15)', () => {
  test("Brave's Goggle is only good to know; a redirect parameter is still something to check", () => {
    const r = A('https://search.brave.com/goggles?q=rust&goggles_id=https%3A%2F%2Fraw.githubusercontent.com%2Fbrave%2Fgoggles-quickstart%2Fmain%2Fgoggles%2Frust_programming.goggle');
    const w = warning(r, 'hidden-address');
    assert.equal(w.tier, 'info');
    assert.equal(w.text, 'This link holds a second address (in goggles_id=), which the page needs. It points to raw.githubusercontent.com.');
    assert.ok(r.hidden[0].kept && r.hidden[0].text.startsWith('https%3A'));
    assert.equal(warning(A('https://example.com/go?next=https://evil.example/x'), 'hidden-address').tier, 'check');
  });

  test('a parameter name cannot add words to the hidden-address sentence (security review, older code)', () => {
    const r = A('https://example.com/go?x.%20No%20warning%20signs%20found.%20Next=https://evil.example/');
    const w = warning(r, 'hidden-address');
    assert.equal(w.text, 'A second address is hidden inside this link (in x.%20No%20warning%20signs%20found.%20Next=). It points to evil.example.');
    assert.equal(r.hidden[0].name, 'x. No warning signs found. Next', 'the data keeps the name as decoded');
  });

  test('the Maps note names Pin only only when there is one', () => {
    const noPin = A('https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sCafes!3m4!1s0x1:0x2!8m2!3d999!4d5.2');
    assert.equal(noPin.maps.pin, null);
    // Place only (spec 18) needs no coordinates of its own: the feature ID still pairs with
    // the final !3d!4d, so the note points to Place only alone.
    assert.equal(noPin.maps.place.link, 'https://maps.google.com/?cid=2');
    assert.equal(warning(noPin, 'maps-context').text, "This map address also holds something Maps picked up on the way to this place: a category or search words ('Cafes'). Cutting it could break the link, so CheckLink leaves it in. Place only, under the clean link, leaves it out.");
    assert.ok(!warning(noPin, 'maps-context').text.includes('Pin only'));
    const neither = A('https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sCafes!3m4!1s0x1:0x0!8m2!3d999!4d5.2');
    assert.equal(neither.maps.pin, null);
    assert.equal(neither.maps.place, null);
    assert.equal(warning(neither, 'maps-context').text, "This map address also holds something Maps picked up on the way to this place: a category or search words ('Cafes'). Cutting it could break the link, so CheckLink leaves it in.");
  });
});

describe('the report e-mail around the new safeguards', () => {
  test('a part whose rule says it identifies the recipient carries recipient: true; a campaign tag does not', () => {
    const r = A('https://shop.example/p?_kx=abc.DEF&utm_source=email');
    assert.equal(part(r, '_kx').recipient, true);
    assert.equal(part(r, 'utm_source').recipient, undefined);
  });

  test('an email= address keeps its own reason', () => {
    assert.equal(reportMail(A('https://example.com/a?email=x@example.com'), []).originalReason, 'email');
  });

  test('a hidden address that holds nothing personal does not keep the links out', () => {
    const m = reportMail(A('https://example.com/go?u=aHR0cHM6Ly9leGFtcGxlLm9yZy9wYWdl&utm_source=x'));
    assert.equal(m.original, true);
    assert.equal(m.clean, true);
  });

  test('removed, a recipient token no longer keeps the clean link out', () => {
    const r = A('https://shop.example/p?_kx=abc.DEF&utm_source=email');
    const m = reportMail(r, r.defaultRemoved);
    assert.equal(m.original, false);
    assert.equal(m.clean, true);
  });
});
