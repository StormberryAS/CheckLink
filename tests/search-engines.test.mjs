// Search-engine result pages and LinkedIn posts as canonical pages (batch 3, build 1, 10
// October 2026; spec decisions 12 to 14 and 17). Run from the repository root with:
// node --test tests/
//
//   1. every test URL of the verified research (tests/search-engine-cases.json, 64 cases);
//   2. Marcos's tests M9, M10, M10b and M11, with the labels they are removed under;
//   3. the remove list: verified parameters go, ticked, even a protected short name;
//   4. conditions: a keep entry that holds only sometimes, and what it is removed as;
//   5. requires and unless: a home page, SearXNG on any host, Mojeek's API;
//   6. hosts and paths that must not match;
//   7. LinkedIn posts, and Instagram's sharer identifiers (mdxt, exln);
//   8. the rule build refusing malformed rules of the new kinds;
//   9. wording, the basis in the generated table, and the invariants.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test, after } from 'node:test';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse } from '../src/link-core.js';
import { RULES } from '../src/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cases: RESEARCH } = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'search-engine-cases.json'), 'utf8'));
const ENGINE_IDS = ['google-search', 'bing-search', 'yahoo-search', 'yandex-search', 'duckduckgo-search', 'brave-search', 'startpage-search', 'mojeek-search', 'ecosia-search', 'qwant-search', 'baidu-search', 'naver-search', 'searxng-search'];

const seen = [];
function A(input) {
  const r = analyse(input);
  seen.push(r);
  return r;
}
const part = (r, name) => r.parts.find((p) => p.name === name);
const removedNames = (r) => r.parts.filter((p) => r.defaultRemoved.includes(p.id)).map((p) => p.name);
const keptNames = (r) => r.kept.map((k) => k.name);
const pageRules = (r) => new Set(r.parts.map((p) => p.rule).filter((x) => /^(?:canonical|verified-page):/.test(x)).map((x) => x.replace(/^[^:]+:/, '')));

// == 1. the research ==

describe('search engines: every test URL of the verified research', () => {
  test('64 cases from 13 engines', () => {
    assert.equal(RESEARCH.length, 64);
    assert.deepEqual([...new Set(RESEARCH.map((c) => c.rule))].sort(), [...ENGINE_IDS].sort());
  });

  for (const c of RESEARCH) {
    test(`${c.engine} ${c.n}: ${c.dirty.slice(0, 80)}`, () => {
      const r = A(c.dirty);
      assert.equal(r.cleanLink, c.clean);
      for (const id of pageRules(r)) assert.equal(id, c.rule, 'removed under the rule for this engine');
    });
  }
});

// == 2. Marcos's tests ==

describe("search engines: Marcos's tests", () => {
  // Since spec decision 20 (10 October 2026) ghc and lq go through a bing.com host rule, on
  // every Bing path, with the label the result-page rule gave them.
  test('M9 Bing: ghc and lq go, labelled as search-box values from the verified research', () => {
    const r = A('https://www.bing.com/search?q=bag&form=QBLH&sp=-1&ghc=1&lq=0&pq=bag&sc=11-3&qs=n&sk=&cvid=530E0FE2A0144F4386F8A1B47BF7E1E4');
    assert.equal(r.cleanLink, 'https://www.bing.com/search?q=bag');
    const block = RULES.extraHosts.find((h) => h.patterns.length === 1 && h.patterns[0] === 'bing.com');
    for (const n of ['ghc', 'lq']) {
      const p = part(r, n);
      assert.deepEqual([p.provider, p.rule, p.defaultRemove, p.unrecognised, p.family], ['Bing search-box value', block.params.find((x) => x.name === n).id, true, false, 'Microsoft']);
    }
    assert.equal(part(r, 'form').rule, 'h17.0', 'a verified tracker keeps its own label');
  });

  test('M10 DuckDuckGo: t and origin go though t is a protected short name; ia=web goes as the default tab', () => {
    const r = A('https://duckduckgo.com/?ia=web&origin=funnel_home_website&t=h_&q=bag');
    assert.equal(r.cleanLink, 'https://duckduckgo.com/?q=bag');
    assert.ok(RULES.protectedNames.includes('t'));
    assert.deepEqual([part(r, 't').provider, part(r, 't').defaultRemove, part(r, 't').ask], ['DuckDuckGo partner code', true, false]);
    assert.equal(part(r, 'origin').provider, 'DuckDuckGo entry point');
    assert.equal(part(r, 'ia').provider, 'DuckDuckGo default tab');
    assert.deepEqual(keptNames(r), ['q']);
  });

  test('M10b DuckDuckGo: a tab other than the web results stays', () => {
    const r = A('https://duckduckgo.com/?q=bag&t=h_&iax=images&ia=images');
    assert.equal(r.cleanLink, 'https://duckduckgo.com/?q=bag&iax=images&ia=images');
    assert.deepEqual(keptNames(r), ['q', 'iax', 'ia']);
  });

  test('M11 Brave Search: source goes though it is a protected short name', () => {
    const r = A('https://search.brave.com/search?q=bag&source=web');
    assert.equal(r.cleanLink, 'https://search.brave.com/search?q=bag');
    assert.ok(RULES.protectedNames.includes('source'));
    assert.deepEqual([part(r, 'source').provider, part(r, 'source').defaultRemove], ['Brave Search entry point', true]);
  });

  test('M5 Google still passes, now with the canonical rule as well', () => {
    const r = A('https://www.google.com/search?q=bag&sca_esv=c9511313c89d4e60&source=hp&ei=HgbKav7sDZatwPAPi6_fCQ&oq=bag&sclient=gws-wiz');
    assert.equal(r.cleanLink, 'https://www.google.com/search?q=bag');
    assert.equal(part(r, 'ei').rule, 'h2.1', 'the verified Google rule keeps its own label');
  });
});

// == 3. the remove list ==

describe('search engines: the remove list', () => {
  for (const [link, name, provider, clean] of [
    ['https://duckduckgo.com/?q=bag&from=x', 'from', 'DuckDuckGo test markers', 'https://duckduckgo.com/?q=bag'],
    ['https://duckduckgo.com/?q=bag&iaxm=maps&source=maps', 'source', 'DuckDuckGo map origin', 'https://duckduckgo.com/?q=bag&iaxm=maps'],
    ['https://html.duckduckgo.com/html/?q=bag&v=l', 'v', 'DuckDuckGo next-page form values', 'https://html.duckduckgo.com/html/?q=bag'],
    ['https://www.startpage.com/sp/search?query=bag&t=device&source=x', 't', 'Startpage theme', 'https://www.startpage.com/sp/search?query=bag'],
    ['https://yandex.com/search/?text=bag&from=os', 'from', 'Yandex entry point', 'https://yandex.com/search/?text=bag'],
    ['https://www.mojeek.com/search?q=bag&ref=1', 'ref', 'Mojeek display setting', 'https://www.mojeek.com/search?q=bag'],
    ['https://www.qwant.com/?q=bag&p=2', 'p', 'Values Qwant ignores', 'https://www.qwant.com/?q=bag'],
    ['https://search.naver.com/search.naver?query=bag&page=2&start=16', 'page', 'Naver page number', 'https://search.naver.com/search.naver?query=bag&start=16'],
    ['https://www.baidu.com/s?wd=bag&ref=a&from=b', 'ref', 'Baidu mobile log values', 'https://www.baidu.com/s?wd=bag'],
  ]) {
    test(`${new URL(link).hostname}: protected "${name}" goes, ticked, as ${provider}`, () => {
      assert.ok(RULES.protectedNames.includes(name));
      const r = A(link);
      const p = part(r, name);
      assert.deepEqual([p.provider, p.defaultRemove, p.ask, p.unrecognised], [provider, true, false, false]);
      assert.equal(r.cleanLink, clean);
    });
  }

  test('a global keep rule gives way to the page remove list (Baidu lid), and nowhere else', () => {
    const r = A('https://www.baidu.com/s?wd=bag&lid=abc123');
    assert.equal(part(r, 'lid').provider, 'Baidu mobile log values');
    assert.equal(r.cleanLink, 'https://www.baidu.com/s?wd=bag');
    assert.equal(A('https://example.com/p?lid=abc123').cleanLink, 'https://example.com/p?lid=abc123');
  });

  test('a protected short name on no list stays an unticked Unrecognised part on an engine page', () => {
    for (const link of ['https://www.google.com/search?q=bag&id=3', 'https://duckduckgo.com/?q=bag&tag=x', 'https://search.brave.com/search?q=bag&c=1']) {
      const r = A(link);
      const p = r.parts.find((x) => RULES.protectedNames.includes(x.name));
      assert.deepEqual([p.unrecognised, p.ask, p.defaultRemove], [true, true, false], link);
      assert.equal(r.cleanLink, link, link);
    }
  });

  test('anything else on an engine page is Unrecognised and ticked', () => {
    const r = A('https://search.brave.com/search?q=bag&zzq=1');
    assert.deepEqual([part(r, 'zzq').unrecognised, part(r, 'zzq').defaultRemove, part(r, 'zzq').provider, part(r, 'zzq').rule], [true, true, 'Brave Search', 'canonical:brave-search']);
    assert.equal(r.cleanLink, 'https://search.brave.com/search?q=bag');
  });

  test('a name in capitals is looked up in small letters on the remove list (Bing FORM)', () => {
    assert.equal(A('https://www.bing.com/images/search?q=bag&FORM=HDRSC2').cleanLink, 'https://www.bing.com/images/search?q=bag');
  });

  test('a remove part can be unticked like any other, and the clean link keeps it byte for byte', () => {
    const r = A('https://duckduckgo.com/?q=bag&t=h_');
    const id = part(r, 't').id;
    assert.equal(r.clean(r.defaultRemoved.filter((x) => x !== id)), 'https://duckduckgo.com/?q=bag&t=h_');
  });
});

// == 4. conditions ==

describe('search engines: keep entries that hold only under a condition', () => {
  const clean = (s) => A(s).cleanLink;
  test("DuckDuckGo's tab values follow DuckDuckGo's own resolver", () => {
    assert.equal(clean('https://duckduckgo.com/?q=bag&ia=images&iax=videos'), 'https://duckduckgo.com/?q=bag', 'ia and iax disagree: web results');
    assert.equal(clean('https://duckduckgo.com/?q=bag&iar=images'), 'https://duckduckgo.com/?q=bag&iar=images', 'iar alone chooses the tab');
    assert.equal(clean('https://duckduckgo.com/?q=bag&iar=images&ia=images&iax=images'), 'https://duckduckgo.com/?q=bag&ia=images&iax=images', 'iar is not needed when ia and iax choose');
    assert.equal(clean('https://duckduckgo.com/?q=bag&ia=news&iar=news'), 'https://duckduckgo.com/?q=bag&ia=news&iar=news');
    assert.equal(clean('https://duckduckgo.com/?q=bag&ia=chat&prompt=1'), 'https://duckduckgo.com/?q=bag&ia=chat&prompt=1');
    assert.equal(clean('https://duckduckgo.com/?q=bag&prompt=1'), 'https://duckduckgo.com/?q=bag', 'prompt only matters with the chat tab');
    assert.equal(clean('https://duckduckgo.com/?q=bag&ia=about'), 'https://duckduckgo.com/?q=bag', 'a quick-answer id does not choose a tab');
    assert.equal(clean('https://duckduckgo.com/?q=cafe&iaxm=maps&ia=web&bbox=1%2C2%2C3%2C4'), 'https://duckduckgo.com/?q=cafe&iaxm=maps&bbox=1%2C2%2C3%2C4');
    assert.equal(clean('https://duckduckgo.com/?q=bag&iaxm=directions&start=a&end=b&transport=walking'), 'https://duckduckgo.com/?q=bag&iaxm=directions&start=a&end=b&transport=walking');
    const st = A('https://start.duckduckgo.com/?q=bag&start=1');
    assert.equal(st.cleanLink, 'https://start.duckduckgo.com/?q=bag');
    assert.equal(part(st, 'start').provider, 'DuckDuckGo start-page mode');
  });

  test('DuckDuckGo s stays on the basic pages; on the main page it is an unticked Unrecognised part', () => {
    assert.ok(keptNames(A('https://duckduckgo.com/lite/?q=bag&s=10')).includes('s'));
    const p = part(A('https://duckduckgo.com/?q=bag&s=10'), 's');
    assert.deepEqual([p.unrecognised, p.ask], [true, true]);
  });

  test('Google: ie goes only as UTF-8, gs_ssp stays (corrected verified rules), imgrc and imgdii stay in the fragment', () => {
    const u = A('https://www.google.com/search?q=bag&ie=UTF-8');
    assert.deepEqual([part(u, 'ie').provider, u.cleanLink], ['Input character encoding', 'https://www.google.com/search?q=bag']);
    assert.equal(clean('https://www.google.com/search?q=bag&ie=Shift_JIS'), 'https://www.google.com/search?q=bag&ie=Shift_JIS');
    const g = A('https://www.google.com/search?q=bag&gs_ssp=eJzj4tVP1zc0LDGNz8kqNjEwYPRiTUpMVwAAPa8F2Q&gs_lp=abc');
    assert.equal(g.cleanLink, 'https://www.google.com/search?q=bag&gs_ssp=eJzj4tVP1zc0LDGNz8kqNjEwYPRiTUpMVwAAPa8F2Q');
    assert.match(g.kept.find((k) => k.name === 'gs_ssp').note, /^Google Search: gs_ssp pins/);
    assert.equal(clean('https://www.google.com/search?q=x&tbm=isch&ved=abc#imgrc=AbCdEf&imgdii=XyZ&zz=1'), 'https://www.google.com/search?q=x&tbm=isch#imgrc=AbCdEf&imgdii=XyZ');
  });

  test('Yahoo ei and Yandex promo are removed under their own labels when the condition fails', () => {
    const y = A('https://search.yahoo.com/search?p=bag&ei=UTF-8');
    assert.deepEqual([y.cleanLink, part(y, 'ei').provider], ['https://search.yahoo.com/search?p=bag', 'Input character encoding']);
    assert.equal(clean('https://search.yahoo.com/search?p=bag&ei=EUC-JP'), 'https://search.yahoo.com/search?p=bag&ei=EUC-JP');
    assert.equal(clean('https://yandex.com/search/?text=bag&promo=force_neuro'), 'https://yandex.com/search/?text=bag&promo=force_neuro');
    const p = A('https://yandex.com/search/?text=bag&promo=spring');
    assert.deepEqual([p.cleanLink, part(p, 'promo').provider], ['https://yandex.com/search/?text=bag', 'Yandex promotion code']);
  });

  test('Baidu: tn, usm, ct and cl depend on the page; empty values are dropped', () => {
    assert.equal(part(A('https://www.baidu.com/s?wd=bag&tn=baidu'), 'tn').provider, 'Baidu partner code');
    assert.equal(clean('https://www.baidu.com/s?wd=bag&tn=news'), 'https://www.baidu.com/s?wd=bag&tn=news');
    assert.equal(clean('https://www.baidu.com/s?wd=bag&pn=10&usm=2'), 'https://www.baidu.com/s?wd=bag&pn=10&usm=2');
    assert.equal(clean('https://www.baidu.com/s?wd=bag&pn=0&usm=2'), 'https://www.baidu.com/s?wd=bag&pn=0');
    assert.equal(clean('https://www.baidu.com/s?wd=bag&ct=1'), 'https://www.baidu.com/s?wd=bag&ct=1');
    assert.equal(clean('https://image.baidu.com/search/index?word=bag&ct=201326592'), 'https://image.baidu.com/search/index?word=bag');
    const e = A('https://www.baidu.com/s?wd=bag&rn=');
    assert.deepEqual([e.cleanLink, part(e, 'rn').reveals, part(e, 'rn').empty], ['https://www.baidu.com/s?wd=bag', 'It holds nothing, so the page opens the same without it.', true]);
  });

  test('Naver: tab filters stay on their own tab only; empty values are dropped', () => {
    assert.equal(clean('https://search.naver.com/search.naver?where=news&query=bag&sort=1'), 'https://search.naver.com/search.naver?where=news&query=bag&sort=1');
    assert.equal(clean('https://search.naver.com/search.naver?where=nexearch&query=bag&sort=1'), 'https://search.naver.com/search.naver?where=nexearch&query=bag');
    assert.equal(clean('https://search.naver.com/search.naver?ssc=tab.cafe.all&query=bag&st=date&date_from='), 'https://search.naver.com/search.naver?ssc=tab.cafe.all&query=bag&st=date');
  });

  test('Qwant source stays on news and is an unticked Unrecognised part on web results', () => {
    assert.equal(clean('https://www.qwant.com/?q=bag&t=news&source=bbc.co.uk'), 'https://www.qwant.com/?q=bag&t=news&source=bbc.co.uk');
    const p = part(A('https://www.qwant.com/?q=bag&t=web&source=bbc.co.uk'), 'source');
    assert.deepEqual([p.unrecognised, p.ask], [true, true]);
  });

  test('Mojeek sst, Ecosia image filters and SearXNG engine settings depend on the page', () => {
    assert.equal(clean('https://www.mojeek.com/search?q=bag&fmt=sst&sst=1'), 'https://www.mojeek.com/search?q=bag&fmt=sst&sst=1');
    assert.equal(part(A('https://www.mojeek.com/search?q=bag&sst=1'), 'sst').provider, 'Mojeek display setting');
    assert.equal(clean('https://www.ecosia.org/images?q=bag&size=large'), 'https://www.ecosia.org/images?q=bag&size=large');
    assert.equal(clean('https://www.ecosia.org/search?q=bag&size=large'), 'https://www.ecosia.org/search?q=bag');
    assert.equal(part(A('https://searx.example.org/search?q=bag&theme=simple&enabled_engines=google__general'), 'enabled_engines').provider, 'SearXNG engine setting');
    assert.equal(clean('https://searx.example.org/search?q=bag&theme=simple&enabled_engines=google__general&disabled_engines=bing__general'), 'https://searx.example.org/search?q=bag&enabled_engines=google__general&disabled_engines=bing__general');
    assert.equal(clean('https://searx.example.org/search?q=bag&pageno=1&engine_data-piped-nextpage=abc'), 'https://searx.example.org/search?q=bag&pageno=1');
  });
});

// == 5. requires and unless ==

describe('search engines: requires and unless', () => {
  for (const link of [
    'https://duckduckgo.com/?t=h_&kae=d',
    'https://www.google.com/?hl=nb&zzq=1',
    'https://www.qwant.com/?t=web&zzq=1',
    'https://example.org/search?q=bag&zzq=1',
    'https://example.org/?q=bag&categories=general&zzq=1',
    'https://www.mojeek.com/search?q=bag&fmt=json&theme=dark',
  ]) {
    test(`not a result page here, so nothing unknown goes: ${link}`, () => {
      const r = A(link);
      assert.equal(pageRules(r).size, 0, r.parts.map((p) => p.name).join(','));
      assert.equal(r.parts.filter((p) => p.unrecognised).length, 0);
    });
  }

  test('SearXNG on any host is recognised by its own parameters, under a path prefix too', () => {
    // Batch 3 review finding P1: pageno alone is not SearXNG's (a shop pages with it too); with
    // language and safesearch, as SearXNG's own form writes them, it is.
    assert.equal(A('https://example.org/search?q=bag&pageno=2&zzq=1').cleanLink, 'https://example.org/search?q=bag&pageno=2&zzq=1');
    assert.equal(A('https://example.org/search?q=bag&pageno=2&language=en&safesearch=0&zzq=1').cleanLink, 'https://example.org/search?q=bag&pageno=2&language=en&safesearch=0');
    assert.equal(A('https://example.org/searx/search?q=bag&categories=general&language=en&theme=simple').cleanLink, 'https://example.org/searx/search?q=bag&categories=general&language=en');
    assert.equal(A('https://example.org/?q=bag&category_images=1&image_proxy=1').cleanLink, 'https://example.org/?q=bag&category_images=1');
  });

  test('no instance is named by its host: a private one is recognised by its own values, like any other', () => {
    // Stage 4b review S3 and SC-5 (12 October 2026): the rule once named a private instance by its
    // host, which would have shipped its names with the website and the app.
    for (const host of ['searx.example.org', 'search.example.net', '10.0.0.5:8443']) {
      assert.equal(A(`https://${host}/search?q=bag&theme=simple&safesearch=0&zzq=1`).cleanLink, `https://${host}/search?q=bag&safesearch=0`, host);
      assert.equal(A(`https://${host}/search?q=bag&zzq=1`).cleanLink, `https://${host}/search?q=bag&zzq=1`, host);
    }
    const rule = RULES.canonical.find((r) => r.id === 'searxng-search');
    assert.ok(rule.requires.every((clause) => !('$host' in clause)), 'no clause names a host');
  });

  test('another canonical rule wins over SearXNG on its own site, and a site host rule still applies', () => {
    const r = A('https://www.google.com/search?q=bag&pageno=2');
    assert.equal(part(r, 'pageno').provider, 'Google Search');
    // pageno on its own no longer makes TikTok's search look like SearXNG (batch 3 review
    // finding P1), so nothing there is decided by the SearXNG rule and q stays.
    const t = A('https://www.tiktok.com/search?q=bag&pageno=2&is_from_webapp=1');
    assert.ok(![...t.parts, ...t.kept].some((x) => /searxng/.test(String(x.rule))));
    assert.ok(!removedNames(t).includes('q'));
  });

  test('the Google home page counts with a query, also in the fragment', () => {
    assert.equal(A('https://www.google.com/?q=bag&zzq=1').cleanLink, 'https://www.google.com/?q=bag');
    assert.equal(A('https://www.google.com/webhp#q=bag&zzq=1').cleanLink, 'https://www.google.com/webhp#q=bag');
    assert.equal(A('https://www.google.com/search?as_q=fjord&zzq=1').cleanLink, 'https://www.google.com/search?as_q=fjord');
  });
});

// == 6. hosts and paths that must not match ==

describe('search engines: hosts and paths that must not match', () => {
  for (const link of [
    'https://duckduckgo.com.evil.io/?q=bag&t=h_&zzq=1',
    'https://evilduckduckgo.com/?q=bag&t=h_&zzq=1',
    'https://search.brave.com.evil.io/search?q=bag&source=web&zzq=1',
    'https://www.bing.com.evil.io/search?q=bag&ghc=1&zzq=1',
    'https://www.google.evil.io/search?q=bag&zzq=1',
    'https://www.google.com.evil.io/search?q=bag&zzq=1',
    'https://yandex.evil.io.example/search/?text=bag&clid=1&zzq=1',
    'https://search.yahoo.com.evil.io/search?p=bag&fr=x&zzq=1',
    'https://evil.uk.search.yahoo.com.example/search?p=bag&zzq=1',
    'https://www.baidu.com.evil.io/s?wd=bag&rsv_bp=1&zzq=1',
    'https://search.naver.com.evil.io/search.naver?query=bag&tqi=1&zzq=1',
    'https://www.ecosia.org.evil.io/search?q=bag&tt=mzl&zzq=1',
    'https://www.qwant.com.evil.io/?q=bag&client=x&zzq=1',
    'https://www.mojeek.com.evil.io/search?q=bag&theme=dark&zzq=1',
    'https://www.startpage.com.evil.io/sp/search?query=bag&segment=x&zzq=1',
    'https://duckduckgo.com/settings?q=bag&t=h_&zzq=1',
    'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&zzq=1',
    'https://www.bing.com/maps?q=bag&zzq=1',
    'https://www.google.com/maps/search/bag?zzq=1',
    'https://www.google.com/advanced_search?q=bag&zzq=1',
    'https://www.baidu.com/link?url=abc&eqid=1&zzq=1',
    'https://search.brave.com/settings?q=bag&zzq=1',
    'https://www.startpage.com/sp/captcha?query=bag&zzq=1',
  ]) {
    test(`no engine rule on ${link.slice(0, 80)}`, () => {
      const r = A(link);
      assert.equal([...pageRules(r)].filter((id) => ENGINE_IDS.includes(id) && id !== 'searxng-search').length, 0, [...pageRules(r)].join(','));
      assert.ok(r.cleanLink.includes('zzq=1') || !r.parts.some((p) => p.name === 'zzq' && p.rule !== 'canonical:searxng-search'), r.cleanLink);
    });
  }

  test('country and partner hosts that are listed are covered', () => {
    assert.equal(A('https://uk.search.yahoo.com/search?p=bag&zzq=1').cleanLink, 'https://uk.search.yahoo.com/search?p=bag');
    assert.equal(A('https://yandex.com.tr/search/?text=bag&zzq=1').cleanLink, 'https://yandex.com.tr/search/?text=bag');
    assert.equal(A('https://www.google.co.uk/search?q=bag&zzq=1').cleanLink, 'https://www.google.co.uk/search?q=bag');
    assert.equal(A('https://m.search.naver.com/search.naver?query=bag&zzq=1').cleanLink, 'https://m.search.naver.com/search.naver?query=bag');
  });
});

// == 7. LinkedIn and Instagram ==

describe('LinkedIn posts', () => {
  const POST = 'https://www.linkedin.com/posts/stephanenasser_how-often-does-cold-emailing-vcs-actually-share-7514317849218142217-dxtE/';
  test("M4: Marcos's post link comes back bare; the reshare values go as Unrecognised", () => {
    const r = A(`${POST}?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7514324157678018560&highlightedUpdateType=SOCIAL_SHARE&origin=SOCIAL_SHARE&utm_source=share&utm_medium=member_desktop&rcm=ACoAAAUqnPwBrDpPXO_qiHU709U3xmwDs9WK-JU`);
    assert.equal(r.cleanLink, POST);
    for (const n of ['highlightedUpdateUrn', 'highlightedUpdateType', 'origin']) assert.equal(part(r, n).rule, 'canonical:linkedin-post', n);
    assert.equal(part(r, 'rcm').rule, 'h23.11', 'the verified rule keeps its label');
  });

  for (const link of [
    'https://www.linkedin.com/feed/update/urn:li:activity:7514317849218142217/?origin=SHARED&zzq=1',
    'https://www.linkedin.com/feed/update/urn:li:share:6844785523593134080?zzq=1&lipi=urn%3Ali%3Apage',
    'https://www.linkedin.com/feed/update/urn:li:ugcPost:6856810298419044352/?zzq=1',
    'https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7514317849218142217/?zzq=1',
    'https://no.linkedin.com/posts/someone_a-post-7514317849218142217-dxtE?zzq=1',
    'https://linkedin.com/posts/someone_old-style-activity-7514317849218142217-AbCd/?zzq=1',
  ]) {
    test(`a post page: ${link.slice(0, 80)}`, () => {
      const r = A(link);
      assert.ok(!r.cleanLink.includes('?'), r.cleanLink);
      assert.ok(pageRules(r).has('linkedin-post'));
    });
  }

  for (const link of [
    'https://www.linkedin.com/in/someone/?zzq=1',
    'https://www.linkedin.com/jobs/view/1234567890/?zzq=1',
    'https://www.linkedin.com/feed/?zzq=1',
    'https://www.linkedin.com/feed/update/urn:li:comment:(activity:1,2)/?zzq=1',
    'https://www.linkedin.com.evil.io/posts/someone_a-post-7514317849218142217-dxtE/?zzq=1',
    'https://evil.no.linkedin.com.example/posts/someone_a-post-7514317849218142217-dxtE/?zzq=1',
    'https://www.linkedin.com/posts/someone/?zzq=1',
  ]) {
    test(`not a post page: ${link.slice(0, 80)}`, () => {
      assert.ok(A(link).cleanLink.includes('zzq=1'));
    });
  }

  test('a sign-in token is never cleaned: otpToken stays an unticked part, token= leaves the link untouched', () => {
    const r = A(`${POST}?otpToken=abc123&zzq=1`);
    assert.deepEqual([part(r, 'otpToken').ask, part(r, 'otpToken').rule], [true, 'h23.10']);
    assert.equal(r.cleanLink, `${POST}?otpToken=abc123`);
    const u = A(`${POST}?token=abc123&zzq=1`);
    assert.equal(u.untouched && u.untouched.id, 'auth');
    assert.equal(u.cleanLink, `${POST}?token=abc123&zzq=1`);
  });
});

describe("Instagram's sharer identifiers (spec decision 17)", () => {
  test('mdxt and exln are verified rules that identify the sharer, on every Instagram page', () => {
    const m1 = A('https://www.instagram.com/p/DeTqc0NDifd/?utm_source=ig_web_copy_link&mdxt=NTc4MTIwNjQ2YQ==');
    const m12 = A('https://www.instagram.com/p/DdwU-n0CN7u/?utm_source=ig_web_copy_link&exln=NTc4MTIwNjQ2YQ==');
    for (const [r, n] of [[m1, 'mdxt'], [m12, 'exln']]) {
      const p = part(r, n);
      assert.deepEqual(
        [p.provider, p.reveals, p.defaultRemove, p.unique, p.unrecognised, p.sharer, p.family],
        ['Instagram sharer ID', 'The same value comes with every link this account shares, so it can link the shares back to you.', true, false, false, true, 'Meta'],
      );
    }
    assert.equal(part(m1, 'mdxt').value, part(m12, 'exln').value, 'the same value on two posts');
    assert.equal(atob('NTc4MTIwNjQ2YQ=='), '578120646a');
    assert.equal(A('https://www.instagram.com/stories/someone/3400000000000000000/?exln=abc').cleanLink, 'https://www.instagram.com/stories/someone/3400000000000000000/');
  });
});

// == 8. the rule build ==

describe('search engines: the rule build refuses malformed rules of the new kinds', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'checklink-engines-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const extra = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'extra-rules.json'), 'utf8'));
  const build = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-rules.mjs'), ...args], { encoding: 'utf8' });
  const rule = (all, id) => all.canonical.rules.find((c) => c.id === id);
  const refuse = (label, change, message) => {
    test(`refuses ${label}`, () => {
      const bad = structuredClone(extra);
      change(bad);
      const slug = label.replace(/\W+/g, '-');
      const file = path.join(tmp, `${slug}.json`);
      const out = path.join(tmp, `${slug}.js`);
      writeFileSync(file, JSON.stringify(bad));
      const res = build('--extra', file, '--out', out);
      assert.equal(res.status, 1, res.stdout);
      assert.match(res.stderr, message);
      assert.equal(existsSync(out), false, 'nothing is written');
    });
  };
  refuse('a rule for any host whose requires clause names only the query', (all) => { rule(all, 'searxng-search').requires.push({ q: '.+' }); }, /host "\*" needs requires clauses that each name \$host or a parameter only this software uses/);
  refuse('a rule for any host without requires', (all) => { delete rule(all, 'searxng-search').requires; }, /host "\*" needs requires clauses/);
  refuse('a home-page path without requires', (all) => { delete rule(all, 'duckduckgo-search').requires; }, /matches the home page; that needs requires clauses/);
  refuse('a clause that is not an object', (all) => { rule(all, 'qwant-search').requires = ['q']; }, /a clause is an object with at least one key/);
  refuse('$host with null', (all) => { rule(all, 'qwant-search').requires = [{ $host: null }]; }, /\$host needs a regular expression/);
  refuse('a clause regular expression JavaScript cannot compile', (all) => { rule(all, 'qwant-search').requires = [{ q: '(?P<x>a)' }]; }, /JavaScript cannot compile/);
  refuse('$value outside a keep entry', (all) => { rule(all, 'qwant-search').requires = [{ $value: '.+' }]; }, /"\$value" is not a parameter name/);
  refuse('a name on both the keep and the remove list', (all) => { rule(all, 'brave-search').remove.push({ name: 'q', provider: 'X', reveals: 'Y.' }); }, /"q" is on both the keep and the remove list/);
  refuse('a remove entry that a functional_keep entry contradicts', (all) => { rule(all, 'bing-search').remove.push({ name: 'rdr', provider: 'X', reveals: 'Y.' }); }, /remove names "rdr", which functional_keep bing-search keeps on these hosts/);
  refuse('an otherwise without a when', (all) => { rule(all, 'brave-search').keep[0].otherwise = { provider: 'X', reveals: 'Y.' }; }, /otherwise needs a when/);
  refuse('a remove entry without reveals', (all) => { rule(all, 'brave-search').remove.push({ name: 'zzq', provider: 'X' }); }, /each remove entry needs a name, a provider and reveals/);
  refuse('a remove entry listed twice', (all) => { rule(all, 'brave-search').remove.push({ name: 'summary', provider: 'X', reveals: 'Y.' }); }, /remove lists summary twice/);
  refuse('drop_empty without the text for empty values', (all) => { delete all.canonical.reveals_empty; }, /reveals_empty is required/);
  refuse('a {cc} host written loosely', (all) => { rule(all, 'linkedin-post').hosts.push('{cc}linkedin.com'); }, /must be one exact name/);

  test('the build names each rule for any host and each protected name a remove list removes', () => {
    const res = build('--check');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /canonical rule "searxng-search" applies on any host, only where its requires clauses hold/);
    assert.match(res.stdout, /canonical rule "duckduckgo-search" removes protected "v", "t", "source", "from" on its own pages \(verified there\): accepted/);
    assert.match(res.stdout, /canonical rule "brave-search" removes protected "source" on its own pages/);
  });
});

// == 9. wording, basis and invariants ==

describe('search engines: wording, basis and invariants', () => {
  test('each engine rule cites a Verified basis in the generated table; LinkedIn a structural one', () => {
    for (const id of ENGINE_IDS) {
      const c = RULES.canonical.find((x) => x.id === id);
      assert.match(c.basis, /^Verified: search-engine research of 10 October 2026 \(\S+\.verified\.json, [^)]+\): /, id);
    }
    assert.match(RULES.canonical.find((x) => x.id === 'linkedin-post').basis, /^Structural: .*Posts API documentation/);
    assert.equal(RULES.canonical.at(-1).id, 'searxng-search', 'the rule for any host comes last');
  });

  test('nothing the new rules can show uses an em dash, "safe", an exclamation mark, alarm words or American spelling', () => {
    const texts = [];
    for (const c of RULES.canonical) {
      texts.push(c.provider, c.platform, c.family, c.emptyReveals);
      for (const k of c.keep) texts.push(k.note, k.otherwise && k.otherwise.provider, k.otherwise && k.otherwise.reveals);
      for (const r of c.remove || []) texts.push(r.provider, r.reveals);
    }
    for (const pr of RULES.pathRules) texts.push(pr.provider, pr.reveals, pr.name);
    for (const r of seen) for (const p of r.parts) texts.push(p.provider, p.reveals);
    const shown = texts.filter(Boolean);
    assert.ok(shown.length > 400, `${shown.length} texts`);
    for (const t of shown) {
      assert.ok(!/—|–|--/.test(t), `no em dash, en dash or double hyphen: ${t}`);
      assert.ok(!/\bsafe/i.test(t), `never "safe": ${t}`);
      assert.ok(!t.includes('!'), `no exclamation mark: ${t}`);
      assert.ok(!/\b(scam\w*|fake|malicious|danger\w*)\b/i.test(t), `calm wording: ${t}`);
      assert.ok(!/\b(color\w*|organiz\w*|gray|center(ed|s)?|favorite\w*|behavior\w*|analyz\w*|customiz\w*|optimiz\w*|recogniz\w*|unrecogniz\w*)\b/i.test(t), `British spelling: ${t}`);
    }
    for (const c of RULES.canonical) for (const k of c.keep) assert.ok(k.note.length <= 260, k.note);
  });

  test('segments cover the link, clean() equals the kept segments, and the clean link goes where the analysis says', () => {
    let checked = 0;
    for (const r of seen) {
      if (!r.found) continue;
      const ids = r.parts.filter((p) => p.where !== 'wrapper').map((p) => p.id);
      const choices = [undefined, [], ids, ...ids.map((id) => r.defaultRemoved.filter((x) => x !== id))];
      for (const choice of choices) {
        const segs = r.target.segmentsFor(choice);
        assert.equal(segs.map((s) => s.text).join(''), r.target.link);
        const cut = segs.filter((s) => !s.removed).map((s) => s.text).join('');
        assert.equal(r.clean(choice === undefined ? undefined : [...r.wrappers.map((w) => w.partId), ...choice]), cut, r.link);
        if (segs.some((s) => s.removed)) assert.ok(!/[?&#]$/.test(cut) && !/[?&]&|&#|\?#/.test(cut), `no stray separators in ${cut}`);
        checked++;
      }
      assert.equal(new URL(r.openUrl()).hostname, r.target.host, r.link);
    }
    assert.ok(checked > 500, `checked ${checked} choices`);
  });
});
