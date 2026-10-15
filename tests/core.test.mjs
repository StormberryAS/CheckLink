// Engine tests for src/link-core.js and tools/build-rules.mjs. Run from the repository
// root with: node --test tests/
//
//   1. the verified corpus (rules/provider-test-corpus.json): every dirty link gives the
//      clean link with the default choice, plus what is stripped, asked, kept, unwrapped
//      and flagged as a short link, and the affiliate and "strip asks" variants;
//   2. the 18 cases of the stage-0 prototype;
//   3. spec cases: text preservation, separators, wrappers, untouched links, short links,
//      the address tricks, hidden addresses, link finding and non-web schemes;
//   4. invariants over every analysis: segments cover the link, clean() matches the kept
//      segments for every choice, no stray ? & or #;
//   5. the rule build: deterministic, up to date, and refusing a global rule on a protected
//      short name;
//   6. wording: no em dashes, no "safe", no exclamation marks in anything shown.

import assert from 'node:assert/strict';
import { describe, test, after } from 'node:test';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse, findLinks, hostMatches, splitLink, pctDecode, invisibleChunks, RULES_DATE, RULES_VERSION } from '../src/link-core.js';
import { RULES } from '../src/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'provider-test-corpus.json'), 'utf8'));
const providerRules = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'provider-rules.json'), 'utf8'));

// Every analysis made through A() is kept for the invariant and wording checks at the end.
const seen = [];
function A(input) {
  const r = analyse(input);
  seen.push(r);
  for (const h of r.hidden) if (h.analysis) seen.push(h.analysis);
  return r;
}

const sorted = (xs) => [...xs].sort();
const ids = (r) => r.warnings.map((w) => w.id);
const warning = (r, id) => r.warnings.find((w) => w.id === id);
const partByName = (r, name) => r.parts.find((p) => p.name === name);
const without = (list, drop) => list.filter((id) => !drop.includes(id));
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const nameOf = (p) => (p.where === 'fragment' ? `#${p.name}` : p.name);

// == 1. corpus ==

describe('verified corpus', () => {
  test('the corpus has 214 samples and the rule table 826 rules', () => {
    assert.equal(corpus.samples.length, 214);
    assert.equal(RULES.global.length + RULES.hosts.reduce((n, h) => n + h.params.length, 0), 826);
  });

  for (const c of corpus.samples) {
    test(`${c.id} ${c.dirty.slice(0, 70)}`, () => {
      const r = A(c.dirty);
      assert.equal(r.found, true);
      assert.equal(r.link, c.dirty);
      assert.equal(r.cleanLink, c.clean, 'clean link with the default choice');
      assert.deepEqual(sorted(r.parts.filter((p) => p.where !== 'wrapper' && p.defaultRemove).map(nameOf)), sorted(c.stripped), 'stripped');
      assert.deepEqual(sorted(r.parts.filter((p) => !p.defaultRemove).map(nameOf)), sorted(c.asked || []), 'asked');
      assert.ok(r.parts.every((p) => p.ask === !p.defaultRemove), 'a part kept by default is exactly an "ask" part');
      for (const k of c.kept_functional || []) assert.ok(r.kept.some((x) => x.name === k), `kept ${k}`);
      assert.deepEqual(r.wrappers.map((w) => w.id), c.unwrapped || [], 'unwrapped');
      assert.equal(r.shortLink ? r.shortLink.id : null, c.opaque_redirect || null, 'short link or opaque redirect');
      if (c.redirect_offer) assert.deepEqual([r.offer.id, r.offer.link], [c.redirect_offer.id, c.redirect_offer.target]);
      if (c.clean_if_affiliate_kept) {
        const keepAff = r.defaultRemoved.filter((id) => !r.parts.find((p) => p.id === id).affiliate);
        assert.equal(r.clean(keepAff), c.clean_if_affiliate_kept, 'keep affiliate credit');
      }
      if (c.clean_if_asks_stripped) assert.equal(r.clean(r.parts.map((p) => p.id)), c.clean_if_asks_stripped, 'strip asks too');
      for (const p of r.parts) {
        assert.ok(p.provider && p.reveals, `${p.name} names its provider and what it reveals`);
        assert.equal(typeof p.unique, 'boolean');
      }
    });
  }

  test('the five merged-policy samples differ from the verifier only by affiliate parameters', () => {
    const merged = corpus.samples.filter((c) => c.clean_verified);
    assert.deepEqual(merged.map((c) => c.id), ['G1-22', 'G1-30', 'G2-51', 'G2-72', 'G2-91']);
    for (const c of merged) {
      const r = A(c.dirty);
      assert.equal(r.cleanLink, c.clean);
      // The names the verifier kept as "ask": present in clean_verified, absent from clean.
      const names = (s) => new Set((s.split('?')[1] || '').split('&').map((t) => t.split('=')[0]));
      const was = names(c.clean);
      const askedByVerifier = [...names(c.clean_verified)].filter((n) => !was.has(n));
      assert.ok(askedByVerifier.length > 0);
      const untick = r.parts.filter((p) => askedByVerifier.includes(p.name));
      assert.ok(untick.every((p) => p.affiliate && p.defaultRemove), `${c.id}: only affiliate parts differ`);
      assert.equal(r.clean(without(r.defaultRemoved, untick.map((p) => p.id))), c.clean_verified, `${c.id}: unticking them gives the verifier's result`);
    }
  });
});

// == 2. prototype ==

describe('prototype cases', () => {
  const same = [
    ['https://example.com/article?id=42&utm_source=newsletter&utm_medium=email&fbclid=IwAR123#section', 'https://example.com/article?id=42#section'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&si=abc123&feature=share&list=PL1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1'],
    ['https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?si=8dyy8ff75d4a4fa8', 'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0'],
    ['https://github.com/foo/bar/blob/main/x.md?ref=feature-branch&utm_source=x', 'https://github.com/foo/bar/blob/main/x.md?ref=feature-branch'],
    ['https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3Dhttps%253A%252F%252Fexample.org%252Fpage%253Futm_source%253Dx%2526a%253D1%26sa%3DD&data=05%7C01%7Cme%40corp.no&sdata=abc&reserved=0', 'https://example.org/page?a=1'],
    ['https://bucket.s3.amazonaws.com/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&utm_source=x', 'https://bucket.s3.amazonaws.com/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&utm_source=x'],
    ['https://news.example.com/unsubscribe?mkt_tok=XYZ&utm_medium=email', 'https://news.example.com/unsubscribe?mkt_tok=XYZ'],
    ['https://t.co/abc123', 'https://t.co/abc123'],
    ['https://us1.list-manage.com/track/click?u=abc&id=def&e=123', 'https://us1.list-manage.com/track/click?u=abc&id=def&e=123'],
    [`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64url('https://example.com/?utm_source=bing&x=1')}&ntb=1`, 'https://example.com/?x=1'],
    ['https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F%3Ffbclid%3DIwAR1&h=AT0', 'https://example.com/'],
    ['https://example.com/?q=hello+world%26more&utm_campaign=x', 'https://example.com/?q=hello+world%26more'],
    ['https://google.com.evil.io/url?q=https://bank.example', 'https://google.com.evil.io/url?q=https://bank.example'],
    ['https://example.com/page;jsessionid=ABC123?x=1', 'https://example.com/page?x=1'],
    ['https://app.example.com/#/inbox?utm_source=x', 'https://app.example.com/#/inbox?utm_source=x'],
  ];
  for (const [input, want] of same) test(`unchanged expectation: ${input.slice(0, 70)}`, () => assert.equal(A(input).cleanLink, want));

  // Three prototype expectations predate the verified table and follow it now (the third,
  // LinkedIn /safety/go, follows the review of 10 October 2026, which added the wrapper):
  test('Amazon th is stripped: the verified table removes it (corpus G3-01), unlike the draft spec', () => {
    const r = A('https://www.amazon.co.uk/Some-Product/dp/B000123/ref=sr_1_3?crid=2X&keywords=red+shoes&qid=1728550000&sr=8-3&tag=affil-21&th=1');
    assert.equal(r.cleanLink, 'https://www.amazon.co.uk/Some-Product/dp/B000123');
    assert.equal(partByName(r, 'tag').affiliate, 'Amazon Associates');
    assert.equal(partByName(r, 'th').defaultRemove, true);
  });
  test('xtor in the fragment stays: AT Internet xtor is not in the verified table', () => {
    const r = A('https://www.lemonde.fr/article.html#xtor=RSS-3208');
    assert.equal(r.cleanLink, 'https://www.lemonde.fr/article.html#xtor=RSS-3208');
    assert.equal(r.parts.length, 0);
  });
  test('LinkedIn /safety/go is unwrapped (review F8): the wrapper and its trk go, the inner address is cleaned', () => {
    const r = A('https://www.linkedin.com/safety/go?url=https%3A%2F%2Fstormberry.as%2F%3Futm_source%3Dli&trk=flagship');
    assert.deepEqual(r.wrappers.map((w) => w.id), ['linkedin-safety-go']);
    assert.equal(r.target.link, 'https://stormberry.as/?utm_source=li');
    assert.equal(r.cleanLink, 'https://stormberry.as/');
    assert.equal(r.host, 'stormberry.as');
    assert.equal(r.clean([]), r.link, 'keeping the wrapper keeps the link as written');
    assert.equal(r.hidden.length, 0, 'the address inside is the target now, not a hidden one');
  });
});

// == 3. spec cases ==

describe('the link text is preserved', () => {
  test('+ in a value stays a plus', () => assert.equal(A('https://example.com/search?q=red+shoes&utm_source=x').cleanLink, 'https://example.com/search?q=red+shoes'));
  test('%20 stays %20 in path and value', () => assert.equal(A('https://example.com/a%20b?name=John%20Smith&fbclid=abc').cleanLink, 'https://example.com/a%20b?name=John%20Smith'));
  test('an encoded ampersand stays encoded', () => assert.equal(A('https://example.com/?title=Fish%26Chips&gclid=abc').cleanLink, 'https://example.com/?title=Fish%26Chips'));
  test('lower-case percent escapes keep their case', () => assert.equal(A('https://example.com/caf%c3%a9?utm_medium=email').cleanLink, 'https://example.com/caf%c3%a9'));
  test('an international name keeps its own letters, not xn--', () => {
    const r = A('https://tromsø.no/kart?utm_campaign=x');
    assert.equal(r.cleanLink, 'https://tromsø.no/kart');
    assert.equal(r.host, 'xn--troms-zua.no');
    assert.equal(r.hostAsWritten, 'tromsø.no');
    assert.equal(warning(r, 'disguised'), undefined);
  });
  test('Norwegian letters in the path stay as written', () => assert.equal(A('https://example.no/blåbær/syltetøy?gclid=x').cleanLink, 'https://example.no/blåbær/syltetøy'));
  test('capital letters in host and path are kept', () => assert.equal(A('https://Example.COM/Path/To/Page?utm_source=x').cleanLink, 'https://Example.COM/Path/To/Page'));
  test('a scheme in capitals is read as a link and kept as written', () => {
    const r = A('HTTPS://WWW.EXAMPLE.COM/A?utm_medium=x');
    assert.equal(r.found, true);
    assert.equal(r.cleanLink, 'HTTPS://WWW.EXAMPLE.COM/A');
  });
  test('a link with nothing to remove comes back byte for byte, odd separators included', () => {
    for (const s of ['https://example.com/?a=1&&b=2', 'https://example.com/?#top', 'https://example.com/#', 'https://example.com/?a=1&']) {
      const r = A(s);
      assert.equal(r.cleanLink, s);
      assert.equal(r.changed, false);
    }
  });
  // Since batch 3 (spec decision 11, 10 October 2026) a user name and password before @
  // are an "Address disguise" part, removed by default; the port still stays.
  test('the port is kept; a user name and password before @ are a removable part', () => {
    const r = A('https://user:pw@example.com:8443/x?utm_source=a');
    assert.equal(r.cleanLink, 'https://example.com:8443/x');
    assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== 'u0')), 'https://user:pw@example.com:8443/x');
    assert.ok(ids(r).includes('at-trick'));
  });
});

describe('separators', () => {
  test('removing the first parameter takes its & with it', () => assert.equal(A('https://example.com/p?utm_source=a&id=1').cleanLink, 'https://example.com/p?id=1'));
  test('removing a middle parameter', () => assert.equal(A('https://example.com/p?a=1&utm_source=a&b=2').cleanLink, 'https://example.com/p?a=1&b=2'));
  test('removing every parameter drops the ?', () => assert.equal(A('https://example.com/p?utm_source=a&utm_medium=b').cleanLink, 'https://example.com/p'));
  test('fragment trackers only: no dangling #', () => assert.equal(A('https://example.com/page#utm_source=x&utm_medium=y').cleanLink, 'https://example.com/page'));
  test('mixed fragment keeps its own pairs', () => assert.equal(A('https://example.com/page#pk_campaign=a&section=2').cleanLink, 'https://example.com/page#section=2'));
  test('query cleaned, plain fragment kept', () => assert.equal(A('https://example.com/p?utm_source=x#top').cleanLink, 'https://example.com/p#top'));
  test('an empty fragment goes once something is removed', () => assert.equal(A('https://example.com/?utm_source=x#').cleanLink, 'https://example.com/'));
  test('empty pairs and a trailing & go once something is removed', () => assert.equal(A('https://example.com/?a=1&&utm_source=x&').cleanLink, 'https://example.com/?a=1'));
  test('a query that starts with & is tidied', () => assert.equal(A('https://example.com/?&utm_source=x&a=1').cleanLink, 'https://example.com/?a=1'));
  test('a valueless tracker is removed by name', () => assert.equal(A('https://www.facebook.com/somepage/videos/1/?_rdr').cleanLink, 'https://www.facebook.com/somepage/videos/1/'));
  test('the ? is coloured with the part it belongs to', () => {
    const r = A('https://example.com/p?utm_source=x');
    assert.deepEqual(r.segments, [
      { text: 'https://example.com/p', removed: false, partId: null },
      { text: '?utm_source=x', removed: true, partId: 'q0' },
    ]);
  });
  test('a text fragment (#:~:text=) is kept', () => assert.equal(A('https://www.example.com/page?utm_source=x#:~:text=hello%20world').cleanLink, 'https://www.example.com/page#:~:text=hello%20world'));
  test('a route fragment is left alone', () => assert.equal(A('https://app.example.com/#!/inbox?utm_source=x').cleanLink, 'https://app.example.com/#!/inbox?utm_source=x'));
  test('unknown ids are ignored and an empty choice gives the original', () => {
    const r = A('https://example.com/p?utm_source=a&id=1');
    assert.equal(r.clean(['nope']), r.link);
    assert.equal(r.clean([]), r.link);
  });
});

describe('every part is a choice', () => {
  test('each removed part carries provider, what it reveals, and is removed by default', () => {
    const r = A('https://example.com/a?fbclid=IwAR2F4-dbP0l7Mn1IawQQGCINEz7PYXQvwjNwB&utm_source=newsletter&utm_campaign=summer_sale_2026');
    assert.deepEqual(r.parts.map((p) => [p.name, p.defaultRemove]), [['fbclid', true], ['utm_source', true], ['utm_campaign', true]]);
    assert.equal(partByName(r, 'fbclid').unique, true, 'a click ID is unique to the click');
    assert.equal(partByName(r, 'utm_source').unique, false, 'a campaign label is the same for everyone');
    assert.match(partByName(r, 'fbclid').provider, /Meta|Facebook/);
  });
  test('unticking a part keeps exactly that part', () => {
    const r = A('https://www.amazon.co.uk/dp/B000123/ref=sr_1_3?tag=affil-21&psc=1');
    const tag = partByName(r, 'tag').id;
    assert.equal(r.cleanLink, 'https://www.amazon.co.uk/dp/B000123?psc=1');
    assert.equal(r.clean(without(r.defaultRemoved, [tag])), 'https://www.amazon.co.uk/dp/B000123?tag=affil-21&psc=1');
    const ref = r.parts.find((p) => p.where === 'path');
    assert.equal(ref.value, 'sr_1_3');
    assert.equal(r.clean(without(r.defaultRemoved, [ref.id])), 'https://www.amazon.co.uk/dp/B000123/ref=sr_1_3?psc=1');
  });
  test('an "ask" part is shown but kept until ticked', () => {
    const r = A('https://www.facebook.com/somepage/videos/917830495715016/?source=feed&refsrc=https%3A%2F%2Fm.facebook.com%2F');
    const source = partByName(r, 'source');
    assert.equal(source.defaultRemove, false);
    assert.equal(source.ask, true);
    // Kept, but still marked as a part in the segments, so the page can show it.
    assert.ok(r.segments.some((sg) => sg.partId === source.id && !sg.removed && sg.text === 'source=feed'));
    assert.equal(r.cleanLink, 'https://www.facebook.com/somepage/videos/917830495715016/?source=feed');
    assert.equal(r.clean([...r.defaultRemoved, source.id]), 'https://www.facebook.com/somepage/videos/917830495715016/');
  });
  test('protected short names are never removed by a global rule', () => {
    const s = 'https://example.com/?v=1&t=2&s=3&q=4&id=5&p=6&page=7&ref=8&source=9&from=10&tag=11&lang=12&hl=13&list=14&index=15&var=17&lid=18&c=19&cid=20';
    const r = A(s);
    assert.equal(r.cleanLink, s);
    assert.equal(r.parts.length, 0);
  });
  test('AppsFlyer c goes only next to af_xp', () => {
    assert.equal(A('https://www.example.com/l?af_xp=social&c=autumn').cleanLink, 'https://www.example.com/l');
    assert.equal(A('https://www.example.com/l?c=autumn').cleanLink, 'https://www.example.com/l?c=autumn');
  });
  test(';jsessionid= is removed whatever its case, with a note', () => {
    const r = A('https://shop.example.com/cart;JSESSIONID=0123ABCD?item=4');
    assert.equal(r.cleanLink, 'https://shop.example.com/cart?item=4');
    assert.equal(warning(r, 'jsessionid').tier, 'info');
    assert.equal(r.parts[0].unique, true);
  });
});

describe('wrappers', () => {
  const inner = 'https://example.org/page?utm_source=x&a=1';
  const google = `https://www.google.com/url?q=${encodeURIComponent(inner)}&sa=D&ust=123`;
  const safe = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(google)}&data=05%7C01%7Cme%40corp.no%7Cabc&sdata=AbCdEf0123456789&reserved=0`;

  test('Safe Links around a Google redirect: both layers shown, inner link cleaned', () => {
    const r = A(safe);
    assert.deepEqual(r.wrappers.map((w) => w.id), ['outlook-safelinks', 'google-url']);
    assert.deepEqual(r.wrappers.map((w) => w.link), [safe, google]);
    assert.equal(r.target.link, inner);
    assert.equal(r.cleanLink, 'https://example.org/page?a=1');
    assert.equal(r.host, 'example.org');
    assert.deepEqual(r.segments, [{ text: safe, removed: true, partId: 'w0' }]);
    assert.match(warning(r, 'safelinks').text, /skips Microsoft's click-time check/);
    assert.match(r.parts[0].reveals, /email address/);
  });
  test('keeping a wrapper keeps that layer exactly as it was', () => {
    const r = A(safe);
    assert.equal(r.clean(without(r.defaultRemoved, ['w0'])), safe);
    assert.equal(r.clean(['w0']), google);
    assert.equal(r.clean(['w0', 'w1']), inner, 'wrappers gone, inner parts kept');
  });
  test('Bing base64 (a1...) is decoded offline', () => {
    const r = A(`https://www.bing.com/ck/a?!&&p=abc&ptn=3&u=a1${b64url('https://www.example.no/a?utm_source=bing&x=1')}&ntb=1`);
    assert.deepEqual(r.wrappers.map((w) => w.id), ['bing-ck']);
    assert.equal(r.cleanLink, 'https://www.example.no/a?x=1');
  });
  test('unwrapping stops after five layers and says so', () => {
    let u = 'https://example.org/deep?utm_source=x&k=1';
    for (let i = 0; i < 7; i++) u = `https://www.google.com/url?q=${encodeURIComponent(u)}&sa=D`;
    const r = A(u);
    assert.equal(r.wrappers.length, 5);
    assert.equal(warning(r, 'deep-wrapper').tier, 'check');
  });
  test('a wrapper is unwrapped only into a complete web address', () => {
    const r = A('https://www.google.com/url?q=javascript:alert(1)');
    assert.equal(r.wrappers.length, 0);
    assert.equal(r.shortLink.id, 'google-url');
    assert.equal(r.cleanLink, 'https://www.google.com/url?q=javascript:alert(1)');
  });
  test('a look-alike Google host is not treated as Google', () => {
    for (const s of ['https://www.google.evil.io/url?q=https://bank.example', 'https://google.com.evil.io/url?q=https://bank.example']) {
      const r = A(s);
      assert.equal(r.wrappers.length, 0);
      assert.equal(r.hidden[0].host, 'bank.example');
    }
  });
  test('google.co.uk and amazon.com.br still match their rules', () => {
    assert.equal(A('https://www.google.co.uk/url?q=https%3A%2F%2Fexample.org%2F').cleanLink, 'https://example.org/');
    assert.ok(hostMatches('www.amazon.com.br', 'amazon.*'));
    assert.ok(hostMatches('music.amazon.co.uk', 'amazon.*'));
    assert.ok(!hostMatches('amazon.evil.io', 'amazon.*'));
    assert.ok(!hostMatches('notamazon.com', 'amazon.com'));
  });
  test('the user name before @ cannot make a link look like a Google redirect', () => {
    const r = A('https://www.google.com@evil.example/url?q=https://bank.example');
    assert.equal(r.wrappers.length, 0);
    assert.equal(r.host, 'evil.example');
    assert.ok(ids(r).includes('at-trick'));
  });
  test('an http destination inside an https wrapper is flagged', () => {
    const r = A('https://www.google.com/url?q=http%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dx');
    assert.equal(r.cleanLink, 'http://example.com/a');
    assert.equal(warning(r, 'not-encrypted').tier, 'check');
  });
  test('redd.it is offered, not replaced', () => {
    const r = A('https://redd.it/eorhm');
    assert.equal(r.cleanLink, 'https://redd.it/eorhm');
    assert.equal(r.offer.link, 'https://www.reddit.com/comments/eorhm/');
  });
  test('a Telegram share intent is shown, not replaced', () => {
    const r = A('https://t.me/share/url?url=https%3A%2F%2Fexample.org%2F&text=hi');
    assert.equal(r.wrappers.length, 0);
    assert.equal(r.cleanLink, 'https://t.me/share/url?url=https%3A%2F%2Fexample.org%2F&text=hi');
    assert.equal(r.hidden[0].link, 'https://example.org/');
  });
});

describe('left untouched', () => {
  const s3 = 'https://bucket.s3.eu-north-1.amazonaws.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261010%2Feu-north-1%2Fs3%2Faws4_request&X-Amz-Date=20261010T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef0123456789&utm_source=newsletter';
  test('a signed S3 link keeps every byte, tracker included', () => {
    const r = A(s3);
    assert.equal(r.untouched.id, 'signed');
    assert.equal(r.cleanLink, s3);
    assert.equal(r.parts.length, 0);
    assert.equal(warning(r, 'untouched').tier, 'check');
    assert.match(warning(r, 'untouched').text, /X-Amz-Signature/);
  });
  test('a signed link inside Safe Links: the wrapper goes, the signed link stays whole', () => {
    const r = A(`https://eur02.safelinks.protection.outlook.com/?url=${encodeURIComponent(s3)}&data=05%7C01&reserved=0`);
    assert.deepEqual(r.wrappers.map((w) => w.id), ['outlook-safelinks']);
    assert.equal(r.cleanLink, s3);
    assert.equal(r.untouched.id, 'signed');
  });
  test('X-Goog-Signature is found whatever its case', () => assert.equal(A('https://storage.googleapis.com/b/o.txt?x-goog-signature=abc&x-goog-date=1&utm_source=x').untouched.id, 'signed'));
  test('CloudFront needs Signature together with Key-Pair-Id', () => {
    assert.equal(A('https://d111.cloudfront.net/v.mp4?Expires=1&Signature=abc~&Key-Pair-Id=K2&utm_source=x').untouched.id, 'signed');
    const r = A('https://example.com/form?Signature=yes&utm_source=x');
    assert.equal(r.untouched, null);
    assert.equal(r.cleanLink, 'https://example.com/form?Signature=yes');
  });
  test('an Azure SAS link (sig) is left alone', () => {
    const s = 'https://acct.blob.core.windows.net/c/f.zip?sv=2024-11-04&se=2026-10-11&sp=r&sig=AbC%2Bd%3D&utm_campaign=x';
    assert.equal(A(s).cleanLink, s);
  });
  test('urldefense is left alone with a note', () => {
    const s = 'https://urldefense.com/v3/__https://example.com/?utm_source=x__;!!abc$';
    const r = A(s);
    assert.equal(r.untouched.id, 'urldefense');
    assert.equal(r.cleanLink, s);
  });
  for (const [name, s] of [
    ['token', 'https://example.com/reset?token=abc123&utm_source=x'],
    ['code and state', 'https://app.example.com/callback?code=4%2F0Ab&state=xyz&utm_medium=email'],
    ['access_token in the fragment', 'https://app.example.com/cb#access_token=ya29.abc&token_type=Bearer&utm_source=x'],
    ['key', 'https://example.com/share?key=AbCdEf&fbclid=IwAR1'],
  ]) {
    test(`a sign-in value (${name}) keeps the link whole, with a warning`, () => {
      const r = A(s);
      assert.equal(r.untouched.id, 'auth');
      assert.equal(r.cleanLink, s);
      assert.match(warning(r, 'untouched').text, /do not share it/);
    });
  }
  test('an unsubscribe link keeps its recipient token, with a note', () => {
    const r = A('https://example.com/unsubscribe?mc_eid=abc123&utm_source=x');
    assert.equal(r.cleanLink, 'https://example.com/unsubscribe?mc_eid=abc123');
    assert.equal(r.kept[0].reason, 'recipient-token');
    assert.match(warning(r, 'recipient-token').text, /do not share this link/);
  });
  test('a preferences page keeps _hsenc; an ordinary page loses it', () => {
    assert.equal(A('https://example.com/email/preferences?_hsenc=p2ANqtz-8AbC&utm_source=hs').cleanLink, 'https://example.com/email/preferences?_hsenc=p2ANqtz-8AbC');
    assert.equal(A('https://example.com/blog?_hsenc=p2ANqtz-8AbC').cleanLink, 'https://example.com/blog');
  });
  test('accounts.google.com is never cleaned', () => {
    const s = 'https://accounts.google.com/signin?continue=https%3A%2F%2Fmail.google.com&utm_source=x';
    assert.equal(A(s).cleanLink, s);
  });
});

describe('short links', () => {
  test('t.co is refused: never followed, link unchanged, warned', () => {
    const r = A('https://t.co/AbCdEf1234');
    assert.deepEqual([r.shortLink.id, r.shortLink.kind, r.shortLink.service], ['x-tco', 'shortener', 'X (Twitter)']);
    assert.equal(r.cleanLink, 'https://t.co/AbCdEf1234');
    assert.equal(r.parts.length, 0);
    assert.equal(warning(r, 'short-link').tier, 'check');
    assert.match(warning(r, 'short-link').text, /through t\.co\. .*CheckLink never opens it\./);
  });
  test('bit.ly from the spec list, its own trackers still removed', () => {
    const r = A('https://bit.ly/3abcDEF?utm_source=x');
    assert.equal(r.shortLink.service, 'Bitly');
    assert.equal(r.cleanLink, 'https://bit.ly/3abcDEF');
  });
  test('a dynamic QR service says the owner can change it', () => {
    const r = A('https://qrco.de/bfAbC1');
    assert.equal(r.shortLink.kind, 'dynamic-qr');
    assert.match(warning(r, 'short-link').text, /can change it/);
  });
  test('a server-side redirect says so', () => {
    const r = A('https://www.google.com/goto?url=CAESHgFxQeBf');
    assert.equal(r.shortLink.kind, 'redirect');
    assert.match(warning(r, 'short-link').text, /goes through Google result redirect/);
  });
  test('a Reddit share code cannot be cleaned offline', () => assert.equal(A('https://www.reddit.com/r/norway/s/AbCdEf123').shortLink.id, 'reddit-share'));
});

describe('address tricks', () => {
  test('@ trick', () => {
    const r = A('https://google.com@evil.example/login');
    assert.equal(r.host, 'evil.example');
    // The disguise row explains the trick (spec decision 11), so the warning says where it
    // goes in fewer words (batch 3 interface review finding 4); the spec's own wording stays
    // where there is no row, on a link left untouched.
    assert.equal(warning(r, 'at-trick').text, 'This address is made to look like a different site. It goes to evil.example: make sure that is the site you expected.');
    assert.equal(warning(r, 'at-trick').tier, 'check');
    assert.equal(warning(A('https://google.com@evil.example/reset?token=abc123'), 'at-trick').text, 'The part before @ is not where this goes. It goes to evil.example.');
  });
  test('0x7f.1 is a disguised 127.0.0.1', () => {
    const r = A('http://0x7f.1/');
    assert.equal(r.host, '127.0.0.1');
    assert.equal(warning(r, 'disguised').text, 'The address as written was disguised (a number written as 0x7f.1). It really goes to 127.0.0.1.');
    assert.equal(warning(r, 'ip-address').tier, 'info');
    assert.equal(warning(r, 'not-encrypted').tier, 'check');
    assert.equal(r.cleanLink, 'http://0x7f.1/', 'the text is never rewritten');
  });
  test('a decimal and an octal address are disguised too', () => {
    assert.equal(A('http://2130706433/').host, '127.0.0.1');
    assert.ok(ids(A('http://2130706433/')).includes('disguised'));
    assert.ok(ids(A('http://0177.0.0.1/')).includes('disguised'));
  });
  test('a zero-width space in the host', () => {
    const r = A('https://goo\u200Bgle.com/x');
    assert.equal(r.host, 'google.com');
    assert.match(warning(r, 'disguised').text, /zero-width space/);
  });
  test('a soft hyphen in the host', () => assert.match(warning(A('https://pay\u00ADpal.com/'), 'disguised').text, /soft hyphen/));
  test('full-width letters', () => assert.match(warning(A('https://\uFF47\uFF4F\uFF4F\uFF47\uFF4C\uFF45.com/'), 'disguised').text, /full-width/));
  test('percent-encoding in the host', () => {
    const r = A('https://%67oogle.com/');
    assert.equal(r.host, 'google.com');
    assert.match(warning(r, 'disguised').text, /percent-encoding/);
  });
  test('a backslash before @', () => {
    const r = A('https://evil.example\\@google.com/');
    assert.equal(r.host, 'evil.example');
    assert.match(warning(r, 'disguised').text, /\(a backslash\)\. It really goes to evil\.example\./);
  });
  test('an invisible character in the path', () => assert.equal(warning(A('https://example.com/a\u200Bb?x=1'), 'invisible').tier, 'check'));
  test('a run of slashes or backslashes after https: is read as the browser reads it (security review 1)', () => {
    const r = A('https:///evil.example;jsessionid=abc@www.paypal.com/signin?utm_source=mail');
    assert.equal(r.host, 'www.paypal.com');
    assert.equal(r.hostAsWritten, 'www.paypal.com');
    // The user part is not a path segment: it goes as one Address disguise part (batch 3),
    // never as a ;jsessionid= or /ref= path part.
    assert.equal(r.cleanLink, 'https:///www.paypal.com/signin');
    assert.deepEqual(r.parts.map((p) => p.where), ['userinfo', 'query']);
    assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== 'u0')), 'https:///evil.example;jsessionid=abc@www.paypal.com/signin');
    assert.ok(ids(r).includes('at-trick'));
    assert.equal(A('https:///ref=x@www.amazon.com/').cleanLink, 'https:///www.amazon.com/');
    assert.deepEqual(A('https:///ref=x@www.amazon.com/').parts.map((p) => p.where), ['userinfo']);
    assert.equal(A('https://\\evil.example;jsessionid=abc@www.google.com/').host, 'www.google.com');
  });
  test('the written host ends at a backslash, and the backslash is still a Check (security review 2)', () => {
    const r = A('https://evil.example\\@www.google.com/');
    assert.equal(r.hostAsWritten, 'evil.example');
    assert.equal(warning(r, 'disguised').tier, 'check');
  });
  test('a direction override before @ is named (security review 4)', () => {
    const r = A('https://\u202Emoc.elgoog@moc.elgoog.ac/');
    assert.equal(r.host, 'moc.elgoog.ac');
    assert.match(warning(r, 'invisible').text, /right-to-left override/);
  });
  test('tag characters and other default-ignorable characters are invisible too (security review 6)', () => {
    assert.match(warning(A('https://example.com/pay\u{E0041}\u{E0042}now'), 'invisible').text, /tag character/);
    assert.equal(warning(A('https://example.com/a\uFFF9b'), 'invisible').tier, 'check');
  });
  test('a sign-in value in a route fragment leaves the link untouched (review F19)', () => {
    const s = 'https://app.example.com/?utm_source=x#/callback?code=abc123&state=xyz';
    const r = A(s);
    assert.equal(r.untouched.id, 'auth');
    assert.equal(r.cleanLink, s);
    assert.equal(A('https://example.com/__/auth/action?mode=resetPassword&oobCode=AbC123&utm_source=x').untouched.id, 'auth');
  });
  test('private addresses are good to know, public ones are a check', () => {
    assert.match(warning(A('http://192.168.1.1/admin'), 'ip-address').text, /your own network/);
    assert.equal(warning(A('http://10.0.0.5/'), 'ip-address').tier, 'info');
    assert.equal(warning(A('http://172.16.4.2/'), 'ip-address').tier, 'info');
    assert.equal(warning(A('http://172.32.4.2/'), 'ip-address').tier, 'check');
    assert.equal(warning(A('https://203.0.113.7/login'), 'ip-address').tier, 'check');
    assert.equal(warning(A('http://[::1]:8080/'), 'ip-address').tier, 'info');
  });
  test('http is flagged, https and .onion are not', () => {
    assert.ok(ids(A('http://example.com/')).includes('not-encrypted'));
    assert.ok(!ids(A('https://example.com/')).includes('not-encrypted'));
    assert.ok(!ids(A('http://example2345abcdefghij.onion/page')).includes('not-encrypted'));
  });
  test('an ordinary link has no warnings', () => assert.deepEqual(A('https://www.example.com/news/article-1?utm_source=x').warnings, []));
});

describe('hidden addresses', () => {
  test('next= pointing elsewhere is a check, and is analysed', () => {
    const r = A('https://example.com/login?next=https://evil.example/?utm_source=x');
    assert.equal(r.hidden[0].host, 'evil.example');
    assert.equal(r.hidden[0].sameHost, false);
    assert.equal(r.hidden[0].analysis.cleanLink, 'https://evil.example/');
    assert.equal(warning(r, 'hidden-address').tier, 'check');
  });
  test('an address on the same site is good to know', () => {
    const r = A('https://www.example.com/go?url=https%3A%2F%2Fexample.com%2Fother');
    assert.equal(r.hidden[0].sameHost, true);
    assert.equal(warning(r, 'hidden-address').tier, 'info');
  });
  test('base64 starting aHR0cHM6Ly is decoded', () => {
    const r = A(`https://example.com/r?d=${Buffer.from('https://evil.example/path').toString('base64')}`);
    assert.equal(r.hidden[0].link, 'https://evil.example/path');
  });
  test('an address in the path', () => assert.equal(A('https://example.com/out/https%3A%2F%2Fevil.example%2F').hidden[0].host, 'evil.example'));
  test('a removed referrer is not reported as hidden', () => assert.equal(A('https://www.linkedin.com/in/example-person/?original_referer=https%3A%2F%2Fwww.google.com%2F').hidden.length, 0));
});

describe('finding the link', () => {
  test('the first link in text, with its position', () => {
    const text = 'Have a look: https://example.com/a?utm_source=x&id=2, thanks! Also www.example.no/side?fbclid=abc.';
    const r = A(text);
    assert.equal(r.link, 'https://example.com/a?utm_source=x&id=2');
    assert.equal(r.start, 13);
    assert.equal(text.slice(r.start, r.end), r.link);
    assert.equal(r.cleanLink, 'https://example.com/a?id=2');
    assert.deepEqual(r.others, ['www.example.no/side?fbclid=abc']);
  });
  test('a bare www. address', () => {
    const r = A('www.example.no/side?utm_source=x');
    assert.equal(r.bare, true);
    assert.equal(r.prefix, 'https://');
    assert.equal(r.cleanLink, 'www.example.no/side');
    assert.ok(ids(r).includes('no-scheme'));
    assert.ok(!ids(r).includes('not-encrypted'));
  });
  test('balanced brackets stay, a closing one outside the link goes', () => {
    assert.equal(A('(see https://en.wikipedia.org/wiki/Bergen_(city))').link, 'https://en.wikipedia.org/wiki/Bergen_(city)');
    assert.equal(A('<https://example.com/x>').link, 'https://example.com/x');
    assert.equal(A('Go to https://example.com/x.').link, 'https://example.com/x');
    assert.equal(A('"https://example.com/x?a=1"').link, 'https://example.com/x?a=1');
    assert.equal(A('Did you see https://example.com/?').link, 'https://example.com/', 'a closing ? is read as punctuation');
  });
  test('square brackets in a query belong to the link', () => assert.equal(A('https://www.facebook.com/NASA/posts/pfbid02abc?__cft__[0]=AZWxyz123').cleanLink, 'https://www.facebook.com/NASA/posts/pfbid02abc'));
  test('an email address at www. is not a link', () => assert.equal(A('mail me at someone@www.example.com please').found, false));
  test('a link a browser cannot read is reported, not analysed', () => {
    const r = A('https://\u202Eexample.com/');
    assert.equal(r.found, false);
    assert.equal(warning(r, 'unreadable').tier, 'check');
  });
  test('empty input', () => {
    const r = A('');
    assert.deepEqual([r.found, r.kind, r.warnings.length, r.clean()], [false, 'none', 0, '']);
  });
  test('findLinks lists every link', () => {
    const { links } = findLinks('a https://one.example/ b http://two.example/x c www.three.example');
    assert.deepEqual(links.map((l) => l.link), ['https://one.example/', 'http://two.example/x', 'www.three.example']);
  });
});

describe('non-web schemes', () => {
  test('javascript: is not a web link', () => {
    const r = A('javascript:alert(1)');
    assert.deepEqual([r.found, r.kind], [false, 'script']);
    assert.equal(r.warnings[0].tier, 'stop');
    assert.equal(r.clean(), '');
  });
  test('JavaScript: in capitals, after spaces, split by a newline', () => {
    assert.equal(A('   JavaScript:void(0)').kind, 'script');
    assert.equal(A('java\nscript:alert(1)').kind, 'script');
  });
  test('a script with a web address inside is still a script', () => {
    const r = A("javascript:location='https://evil.example/'");
    assert.equal(r.kind, 'script');
    assert.deepEqual(r.others, ["https://evil.example/'"].map((s) => s.replace(/'$/, '')));
  });
  test('data: and file: are refused', () => {
    assert.equal(A('data:text/html,<script>alert(1)</script>').kind, 'script');
    assert.equal(A('file:///etc/passwd').kind, 'script');
  });
  test('ordinary text that starts like a scheme is fine', () => assert.equal(A('About: https://example.com/?utm_source=x').cleanLink, 'https://example.com/'));
});

describe('helpers', () => {
  test('splitLink follows the browser on backslashes and #', () => {
    assert.deepEqual(splitLink('https://a.example/p?q=1#f'), { authStart: 8, authEnd: 17, pathStart: 17, pathEnd: 19, qIdx: 19, hIdx: 23 });
    assert.equal(splitLink('https://a.example\\@b/x').authEnd, 17);
    assert.equal(splitLink('https://a.example/p#f?not-query').qIdx, -1);
  });
  test('pctDecode never throws', () => {
    assert.equal(pctDecode('%E2%9C%93 %zz %'), '\u2713 %zz %');
    assert.equal(pctDecode('%C3'), '\uFFFD');
  });
  test('invisibleChunks splits out each invisible or direction-changing character, labelled', () => {
    assert.deepEqual(invisibleChunks('ab\u202Ecd\u200B'), [
      { text: 'ab', invisible: false, label: null },
      { text: '\u202E', invisible: true, label: 'U+202E right-to-left override' },
      { text: 'cd', invisible: false, label: null },
      { text: '\u200B', invisible: true, label: 'U+200B zero-width space' },
    ]);
    assert.deepEqual(invisibleChunks('\u{E0041}').map((c) => c.label), ['U+E0041 tag character']);
    assert.deepEqual(invisibleChunks('plain'), [{ text: 'plain', invisible: false, label: null }]);
    assert.equal(invisibleChunks('a\u202Eb\u{E0041}c').map((c) => c.text).join(''), 'a\u202Eb\u{E0041}c');
  });
  test('the rules date is exported', () => {
    assert.equal(RULES_DATE, providerRules.generated);
    assert.equal(RULES_VERSION, providerRules.version);
    assert.equal(A('https://example.com/').rulesDate, RULES_DATE);
  });
  test('link-core.js stays pure: no DOM, network or Node-only calls', () => {
    const src = readFileSync(path.join(ROOT, 'src', 'link-core.js'), 'utf8');
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.', 'window.', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'Buffer', 'require(', 'process.', 'import(']) {
      assert.ok(!src.includes(banned), `link-core.js must not use ${banned}`);
    }
    assert.ok(!/[^\x00-\x7F]/.test(src), 'link-core.js is plain ASCII (characters are written as \\u escapes)');
  });
});

// == 4. invariants ==

describe('invariants over every analysis', () => {
  test('segments cover the link and clean() equals the kept segments, for every choice', () => {
    let checked = 0;
    for (const r of seen) {
      if (!r.found && !r.link) continue;
      const one = (choice) => {
        const segs = r.target.segmentsFor(choice);
        assert.equal(segs.map((s) => s.text).join(''), r.target.link, 'target segments cover the target');
        const cut = segs.filter((s) => !s.removed).map((s) => s.text).join('');
        const viaClean = r.clean(choice ? [...r.wrappers.map((w) => w.partId), ...choice] : undefined);
        assert.equal(cut, viaClean, `clean() matches the segments for ${r.link}`);
        const removedSomething = segs.some((s) => s.removed);
        if (removedSomething) {
          assert.ok(!/[?&#]$/.test(cut), `no trailing ? & or # in ${cut}`);
          assert.ok(!/[?&]&|&#|\?#/.test(cut), `no doubled separators in ${cut}`);
        }
        const top = r.segmentsFor(choice);
        assert.equal(top.map((s) => s.text).join(''), r.link, 'top segments cover the link');
        checked++;
      };
      one(undefined);
      const targetIds = r.parts.filter((p) => p.where !== 'wrapper').map((p) => p.id);
      if (targetIds.length <= 8) {
        for (let mask = 0; mask < 1 << targetIds.length; mask++) one(targetIds.filter((_, i) => mask & (1 << i)));
      } else {
        one([]);
        one(targetIds);
        for (let i = 0; i < targetIds.length; i++) one(targetIds.filter((_, j) => j !== i));
      }
    }
    assert.ok(checked > 1000, `checked ${checked} choices`);
  });
  test('the clean link always goes to the same host as the target', () => {
    for (const r of seen) {
      if (!r.found) continue;
      const u = new URL(r.openUrl());
      const expected = r.wrappers.length ? r.target.host : r.host;
      assert.equal(u.hostname, expected, r.link);
    }
  });
  test('for every choice, what Go to opens goes to the host named for that choice (the first wrapper kept, or the target)', () => {
    let checked = 0;
    for (const r of seen) {
      if (!r.found) continue;
      const wrapperIds = r.wrappers.map((w) => w.partId);
      const choices = [undefined, [], r.parts.map((p) => p.id), ...wrapperIds.map((_, i) => wrapperIds.filter((__, j) => j !== i))];
      for (const choice of choices) {
        const set = new Set(choice ?? r.defaultRemoved);
        const kept = r.wrappers.findIndex((w) => !set.has(w.partId));
        const expected = kept >= 0 ? r.wrappers[kept].host : r.target.host;
        const url = r.openUrl(choice);
        assert.match(url, /^https?:\/\//i, `${r.link}: ${url}`);
        assert.equal(new URL(url).hostname, expected, `${r.link} with ${JSON.stringify(choice)}: ${url}`);
        checked++;
      }
    }
    assert.ok(checked > 500, `checked ${checked} choices`);
  });
});

// == 5. rule build ==

describe('rule build', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'checklink-rules-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const build = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-rules.mjs'), ...args], { encoding: 'utf8' });

  test('src/rules.js is up to date', () => {
    const res = build('--check');
    assert.equal(res.status, 0, res.stderr);
  });
  test('two builds give identical bytes', () => {
    const a = path.join(tmp, 'a.js');
    const b = path.join(tmp, 'b.js');
    assert.equal(build('--out', a).status, 0);
    assert.equal(build('--out', b).status, 0);
    assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
    assert.equal(readFileSync(a, 'utf8'), readFileSync(path.join(ROOT, 'src', 'rules.js'), 'utf8'));
  });
  test('the two scoped global rules on protected names are accepted and reported', () => {
    const res = build('--out', path.join(tmp, 'c.js'));
    assert.match(res.stdout, /global rule "c" names protected "c" only next to af_xp: accepted/);
    assert.match(res.stdout, /global rule "lid" names protected "lid" but only keeps it: accepted/);
  });
  const refuse = (label, rule) => {
    test(`refuses ${label}`, () => {
      const bad = structuredClone(providerRules);
      bad.global.push({ provider: 'Test', reveals: 'Test', default: 'strip', ...rule });
      const file = path.join(tmp, `bad-${label.replace(/\W+/g, '-')}.json`);
      const out = path.join(tmp, `bad-${label.replace(/\W+/g, '-')}.js`);
      writeFileSync(file, JSON.stringify(bad));
      const res = build('--rules', file, '--out', out);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /refused/);
      assert.equal(existsSync(out), false, 'nothing is written');
    });
  };
  refuse('a global ref rule', { name: 'ref', match: { type: 'exact', value: 'ref' } });
  refuse('a global prefix that covers c, cid and code', { name: 'c*', match: { type: 'prefix', value: 'c' } });
  refuse('a global regex that covers token', { name: 'tok', match: { type: 'regex', value: '^tok' } });
  refuse('a global ask rule on tag', { name: 'tag', match: { type: 'exact', value: 'tag' }, default: 'ask' });
  refuse('an exclusion-only condition on v', { name: 'v', match: { type: 'exact', value: 'v' }, conditions: { except_hosts: ['youtube.com'] } });
  refuse('a regex JavaScript cannot compile', { name: 'x', match: { type: 'regex', value: '(?P<n>x)' } });
  test('refuses a never_strip entry that would keep a name a host rule strips on the same hosts (review F4)', () => {
    const extra = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'extra-rules.json'), 'utf8'));
    extra.corrections.items = extra.corrections.items.filter((c) => c.finding !== 'F4');
    const file = path.join(tmp, 'extra-no-f4.json');
    const out = path.join(tmp, 'extra-no-f4.js');
    writeFileSync(file, JSON.stringify(extra));
    const res = build('--extra', file, '--out', out);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /functional_keep tiktok keeps "q" on every path of tiktok\.com, so the host rule "q"/);
    assert.equal(existsSync(out), false, 'nothing is written');
  });
  test('refuses a correction whose entry no longer holds the expected values', () => {
    const bad = structuredClone(providerRules);
    bad.redirects.find((r) => r.id === 'tradedoubler').match = '^https?://tradedoubler\\.com/';
    const file = path.join(tmp, 'bad-correction.json');
    const out = path.join(tmp, 'bad-correction.js');
    writeFileSync(file, JSON.stringify(bad));
    const res = build('--rules', file, '--out', out);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /correction F6 on redirects .*tradedoubler.*expected/);
    assert.equal(existsSync(out), false, 'nothing is written');
  });
  test('the provider patterns refuse the private two-label suffixes and keep the real ones (review F6)', () => {
    for (const h of ['www.google.com.de', 'google.co.no', 'amazon.co.com', 'www.amazon.com.se', 'google.co.business']) assert.ok(!hostMatches(h, 'google.*') && !hostMatches(h, 'amazon.*'), h);
    for (const h of ['www.google.co.uk', 'www.google.no', 'www.amazon.com.br', 'www.amazon.co.jp', 'www.google.com.au']) assert.ok(hostMatches(h, 'google.*') || hostMatches(h, 'amazon.*'), h);
  });
  test('a host rule on a protected name is fine', () => {
    assert.ok(RULES.hosts.some((h) => h.params.some((p) => p.name === 'ref' && p.default === 'strip')));
  });
});

// == 6. wording ==

describe('wording', () => {
  test('no rule text the page can show uses an em dash, "safe", an exclamation mark, alarm words or American spelling', () => {
    // Everything in src/rules.js that reaches the page: what each part reveals and who
    // provides it, its family and affiliate network, the notes under "Kept on purpose",
    // path-rule texts, wrapper labels and short-link services. Product names keep their own
    // spelling (Microsoft's Safe Links, Google Merchant Center).
    const texts = [];
    for (const r of [...RULES.global, ...RULES.extraGlobal, ...[...RULES.hosts, ...RULES.extraHosts].flatMap((h) => h.params)]) texts.push(r.reveals, r.provider, r.family, r.affiliate);
    for (const f of RULES.functionalKeep) texts.push(f.note);
    for (const pr of RULES.pathRules) texts.push(pr.reveals, pr.provider, pr.name, pr.warning, pr.family);
    for (const rd of RULES.redirects) texts.push(rd.label, rd.family);
    for (const sl of RULES.shortLinks) texts.push(sl.service);
    texts.push(RULES.recipientTokens.note);
    const shown = texts.filter(Boolean).map((t) => t.replace(/Safe Links/g, '').replace(/Merchant Center/g, ''));
    assert.ok(shown.length > 2000, `${shown.length} texts`);
    for (const t of shown) {
      assert.ok(!/\u2014|\u2013|--/.test(t), `no em dash, en dash or double hyphen: ${t}`);
      assert.ok(!/\bsafe/i.test(t), `never "safe": ${t}`);
      assert.ok(!t.includes('!'), `no exclamation mark: ${t}`);
      assert.ok(!/\b(scam\w*|fake|malicious)\b/i.test(t), `calm wording: ${t}`);
      assert.ok(!/\b(color\w*|organiz\w*|gray|center(ed|s)?|favorite\w*|behavior\w*|analyz\w*|customiz\w*|optimiz\w*|recogniz\w*|cataloged)\b/i.test(t), `British spelling: ${t}`);
    }
  });
  test('nothing shown uses an em dash, "safe", an exclamation mark or alarm words', () => {
    const texts = [];
    for (const r of seen) {
      for (const w of r.warnings) texts.push(w.text);
      // (The Address disguise part has no provider line: provider is null.)
      for (const p of r.parts) texts.push(p.reveals, p.provider ?? '', p.name);
      for (const k of r.kept) texts.push(k.note || '');
      if (r.untouched) texts.push(r.untouched.text);
    }
    assert.ok(texts.length > 500);
    for (const t of texts) {
      assert.ok(!t.includes('\u2014') && !t.includes('--'), `no em dash or double hyphen: ${t}`);
      assert.ok(!/\bsafe\b/i.test(t.replace(/Safe Links/g, '')), `never "safe" (Microsoft's product name Safe Links aside): ${t}`);
      assert.ok(!/\b(scam|fake|malicious)\b/i.test(t), `calm wording: ${t}`);
    }
    for (const r of seen) for (const w of r.warnings) assert.ok(!w.text.includes('!'), `no exclamation mark: ${w.text}`);
  });
});
