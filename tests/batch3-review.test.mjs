// Adversarial review of batch 3 cleaning accuracy (10 October 2026): the LinkedIn post rule,
// the 13 search-engine rules, Instagram's sharer IDs (mdxt, exln) and the address disguise
// part. Run from the repository root with: node --test tests/
//
// Lens: over-cleaning (a working link loses a part it needs) and under-cleaning (a tracker
// or identifier stays), checked against the search-engine research the rules cite
// (scratchpad qrlink/search-engines/*.verified.json) and against real link shapes: image,
// video, news, maps and jobs tabs, pagination, filters, mobile hosts, country domains,
// capitals and redirects.
//
// Same convention as tests/adversarial.test.mjs: a test marked { todo: 'Pn ...' } fails today
// and documents proven finding Pn; one marked { todo: 'Ln ...' } documents a likely finding
// whose premise (what the site does with the parameter) could not be checked offline, so
// confirm it before fixing. node --test prints both as TODO without failing the suite. When
// a finding is fixed, remove its todo marker. Tests without a marker pass today and guard
// what this review checked and found right, so that the fixes do not undo it.
//
// Fixing P1 means changing the any-host case in tests/search-engines.test.mjs
// ("example.org/search?q=bag&pageno=2"); fixing P4 means changing the bare-address row in
// tests/address-disguise.test.mjs ("www.google.com@evil.example/x"). Both assert today's
// behaviour.
//
// Fixer pass (10 October 2026): every proven finding (P1 to P10) and the likely findings
// whose fix keeps a part (L1, L2, L3, L5) are fixed, and their tests are ordinary tests now.
// L4 and L6 stayed todo: both would remove more, on a premise not checked online, so they
// waited for Marcos (a slightly longer working link beats a broken one).
//
// Marcos's decisions of 10 October 2026 (spec decisions 20 to 23): L4 yes (Bing's search-box
// and session values go on every bing.com path), L6 yes (instagr.am joins the sharer rule),
// and L2 reversed (DuckDuckGo iai goes, as the research says). No test here is todo now.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { analyse } from '../src/link-core.js';

const A = (s) => analyse(s);
const removedNames = (r) => r.parts.filter((p) => r.defaultRemoved.includes(p.id)).map((p) => p.name);
const keptNames = (r) => r.kept.map((k) => k.name);
const disguise = (r) => r.parts.find((p) => p.where === 'userinfo');
// Any part or kept row that the SearXNG rule decided.
const bySearx = (r) => [...r.parts, ...r.kept].filter((p) => /(?:^|:)searxng-search$/.test(String(p.rule)));

// == P. proven findings (todo until fixed) ==

describe('batch 3 review: proven findings', () => {
  // P1. The SearXNG rule applies on any host once q comes with one of its "own" names. Three
  // of those names are common on ordinary sites: category_* matches category_id (shop and
  // CMS category filters), pageno is a common page number, time_range a common filter. The
  // research's detection section calls pageno and category_* "the strongest single signals",
  // which is where the mistake starts. On such a site every other parameter is removed as
  // "Unrecognised: this page opens without it", under the name SearXNG.
  for (const [what, link] of [
    ['a shop search with a category filter', 'https://shop.example.no/search?q=boots&category_id=12&sort=price&brand=acme'],
    ['a product list paged with pageno', 'https://www.example.com/products/shoes/?q=boots&pageno=2&color=red&size=42'],
    ['a news search with a time filter', 'https://news.example.com/search?q=election&time_range=week&section=politics&sort=newest'],
    ['a course search with categories and language', 'https://www.example.org/search?q=python&categories=programming&language=en&level=beginner'],
    ['a forum search with an engines filter', 'https://forum.example.net/search?q=v8&engines=petrol&model=mustang'],
  ]) {
    test(`P1: ${what} is not taken for SearXNG`, () => {
      const r = A(link);
      assert.deepEqual(bySearx(r).map((p) => p.name), [], 'decided by the SearXNG rule');
      assert.equal(r.cleanLink, link);
    });
  }

  // P2. LinkedIn's "Copy link to comment" writes commentUrn and dashCommentUrn (replies add
  // replyUrn and dashReplyUrn); opening the link scrolls to that comment. The linkedin-post
  // rule keeps nothing, so all four go as Unrecognised and the link opens the bare post.
  const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/';
  const COMMENT = 'commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381234567890123999%29&dashCommentUrn=urn%3Ali%3Afsd_comment%3A%287381234567890123999%2Curn%3Ali%3Aactivity%3A7381234567890123456%29';
  const REPLY = 'replyUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381234567890124000%29&dashReplyUrn=urn%3Ali%3Afsd_comment%3A%287381234567890124000%2Curn%3Ali%3Aactivity%3A7381234567890123456%29';
  test('P2: a link to one comment under a post keeps the comment', () => {
    assert.equal(A(`${POST}?${COMMENT}`).cleanLink, `${POST}?${COMMENT}`);
  });
  test('P2: a link to a reply keeps the comment and the reply, and still drops the tracker', () => {
    assert.equal(A(`${POST}?${COMMENT}&${REPLY}&utm_source=share`).cleanLink, `${POST}?${COMMENT}&${REPLY}`);
  });
  test('P2: the /posts/ form keeps commentUrn too', () => {
    const base = 'https://www.linkedin.com/posts/marcos-povoa_some-title-activity-7381234567890123456-AbCd';
    assert.equal(A(`${base}?utm_source=share&utm_medium=member_desktop&${COMMENT}`).cleanLink, `${base}?${COMMENT}`);
  });

  // P3. The research (mainstream.verified.json, Google notes): "Google Lens result pages
  // (/search?vsrid=...&lns_mode=...&udm=26) depend on session ids and cannot be
  // canonicalised". With an empty q the rule's requires clause keeps it off, but a Lens
  // multisearch (the person typed words to add to the picture) has q, and the rule then
  // removes every Lens value: the link opens a text search with no picture.
  test('P3: a Google Lens multisearch keeps its Lens values', () => {
    const r = A('https://www.google.com/search?q=red+shoes&vsrid=CLabc&vsint=CAIqDAoCCAcSAggKGAE&udm=26&lns_mode=un&source=lns.web.gisbubb&vsdim=1179,1179&gsessionid=abc123&lsessionid=def456&lns_surface=26&lns_vfs=e');
    for (const name of ['vsrid', 'vsint', 'lns_mode', 'vsdim', 'gsessionid', 'lsessionid', 'lns_surface', 'lns_vfs']) {
      assert.ok(!removedNames(r).includes(name), `${name} removed by default`);
    }
    assert.ok(!r.parts.some((p) => p.rule === 'canonical:google-search'), 'Unrecognised parts on a Lens page');
  });

  // P4. A bare link (no scheme) with a disguise always starts with www. (that is how the
  // finder spots it), so the disguise holds the www. and the clean link is "evil.example/x":
  // no scheme and no www. CheckLink itself no longer finds a link in it, and most apps will
  // not make it tappable after Copy or Share. Go to works only because openUrl adds https://.
  for (const link of ['www.google.com@evil.example/login', 'www.paypal.com@evil.example/?utm_source=x']) {
    test(`P4: ${link} cleans to a link CheckLink itself still finds`, () => {
      const r = A(link);
      const again = A(r.cleanLink);
      assert.equal(again.found, true, `no link found in ${JSON.stringify(r.cleanLink)}`);
      assert.equal(again.host, 'evil.example');
      assert.equal(new URL(r.openUrl()).hostname, 'evil.example');
    });
  }

  // P5. Mojeek's paid API (fmt=json or fmt=xml) is excluded from the rule by unless, so its
  // api_key stays in the clean link, with no row and no warning. The research: "api_key: API
  // credential; must never survive cleaning". (The report e-mail side is the security
  // review's F5.)
  for (const fmt of ['json', 'xml']) {
    test(`P5: a Mojeek API address (fmt=${fmt}) never keeps its API key`, () => {
      const r = A(`https://www.mojeek.com/search?q=bergen&fmt=${fmt}&api_key=SECRETKEY123`);
      assert.ok(!r.cleanLink.includes('SECRETKEY123'), r.cleanLink);
    });
  }

  // P6. Baidu's mobile links write more segments before /s than the path rule knows: uid=
  // and baiduid= (the BAIDUID cookie, Baidu's own visitor ID) stay in the clean link, and
  // because the path is then not /s, the Baidu rule never applies to the query either.
  test('P6: Baidu mobile session segments go, baiduid included, and the Baidu rule then applies', () => {
    const r = A('https://m.baidu.com/ssid=0/from=844b/bd_page_type=1/uid=0/baiduid=2B1E3F4A5B6C7D8E9F0A1B2C3D4E5F60:FG=1/s?word=bergen&sa=ib&ts=0');
    assert.equal(r.cleanLink, 'https://m.baidu.com/s?word=bergen');
  });

  // P7. Yahoo's result click redirect (r.search.yahoo.com/_ylt=.../RU=<target>/RK=2/RS=...)
  // is named in the research's redirect_unwrapping list but has no redirect rule. Instead the
  // new yahoo-ylt path rule (host search.yahoo.com, which also matches r.search.yahoo.com)
  // cuts ;_ylu=... out of the middle of the redirect path, next to its RS= signature.
  const YR = 'https://r.search.yahoo.com/_ylt=AwrE.abc;_ylu=Y29sbwNiZjEEcG9zAzEE/RV=2/RE=1700000000/RO=10/RU=https%3a%2f%2fexample.com%2fpage%3fid%3d7/RK=2/RS=abcdef-';
  test('P7: the Yahoo click redirect is unwrapped to the address in RU=', () => {
    assert.equal(A(YR).cleanLink, 'https://example.com/page?id=7');
  });
  test('P7: by default the redirect is either unwrapped or left exactly as written, never edited', () => {
    const c = A(YR).cleanLink;
    assert.ok(c === YR || c === 'https://example.com/page?id=7', c);
  });

  // P8. Yahoo! JAPAN (search.yahoo.co.jp) is not covered at all, so its partner code fr (the
  // research: "fr and frtype are tracking per AdGuard and Firefox (fr=mozff)") stays.
  for (const link of [
    'https://search.yahoo.co.jp/search?p=bergen&fr=mozff&ei=UTF-8',
    'https://search.yahoo.co.jp/search?p=bergen&fr=top_ga1_sa&frtype=1&ei=UTF-8&ts=1234&aq=-1',
  ]) {
    test(`P8: ${link.slice(8, 70)} drops fr and frtype and keeps p`, () => {
      const r = A(link);
      assert.ok(removedNames(r).includes('fr'), removedNames(r).join(','));
      assert.ok(!/[?&]fr(?:type)?=/.test(r.cleanLink), r.cleanLink);
      assert.ok(r.cleanLink.includes('p=bergen'));
    });
  }

  // P9. The disguise part is skipped on hosts a functional_keep entry leaves alone
  // (skip_all_rules: accounts.google.com, myaccount.google.com). That entry is about
  // parameters (ClearURLs' exemption); the at-trick warning still shows, but the disguise
  // cannot be removed.
  test('P9: the disguise is offered on accounts.google.com too', () => {
    const r = A('https://www.paypal.com@accounts.google.com/signin/v2/identifier');
    const u = disguise(r);
    assert.ok(u && u.defaultRemove, 'no disguise part');
    assert.equal(r.cleanLink, 'https://accounts.google.com/signin/v2/identifier');
  });

  // P10. Spec decision 12 lists Bing's keep set as "q, first, count, qft, filters, setlang,
  // mkt, cc, safesearch". The rule follows the research instead (bing.com reads adlt;
  // safeSearch is the retired API's name) and removes safesearch as Unrecognised. The build
  // report does not mention the difference. Either keep it, or have Marcos accept the
  // research and drop this test.
  test('P10: Bing safesearch stays, as spec decision 12 says', () => {
    assert.equal(A('https://www.bing.com/search?q=bergen&safesearch=strict&ghc=1').cleanLink, 'https://www.bing.com/search?q=bergen&safesearch=strict');
  });
});

// == L. likely findings (todo until decided; all decided on 10 October 2026) ==

describe('batch 3 review: likely findings', () => {
  // L1. Google opens one item inside a results page with values the keep list does not name.
  // The research kept only #imgrc, #vhid and #lrd for this ("select an item inside the page",
  // inferred); these others are the same kind and are removed as Unrecognised. Fragment
  // values never reach Google's server, so removing them protects little and breaks the
  // item. Either keep them, or make Unrecognised fragment pairs on search pages "ask".
  for (const [what, link, names] of [
    ['a place picked in local results', 'https://www.google.com/search?q=restaurants+bergen&tbm=lcl&rldimm=1234567890123456789#rlfi=hd:;si:1234567890123456789;mv:[[60.4,5.4],[60.3,5.3]]', ['rldimm', 'rlfi']],
    ['a video preview opened in the results', 'https://www.google.com/search?q=never+gonna+give+you+up#fpstate=ive&vld=cid:5c4e1e3e,vid:dQw4w9WgXcQ,st:0', ['fpstate', 'vld']],
    ['job filters in Google Jobs', 'https://www.google.com/search?q=jobs+bergen&ibp=htl;jobs&htivrt=jobs&htidocid=ABC%3D%3D&htischips=date_posted:week,employment_type:FULLTIME&htilrad=-1.0', ['htivrt', 'htischips', 'htilrad']],
    ['an event opened in Google Events', 'https://www.google.com/search?q=bergen+events&ibp=htl;events#fpstate=tldetail&htivrt=events&htidocid=L2F1dGhvcml0eS9ob3Jpem9u', ['fpstate', 'htivrt']],
    ['a match opened in a sports panel', 'https://www.google.com/search?q=liverpool#sie=m;/g/11x1abc;2;/m/02_tc;dt;fp;1;;;', ['sie']],
  ]) {
    test(`L1: ${what} keeps what opens it`, () => {
      const r = A(link);
      for (const name of names) assert.ok(!removedNames(r).includes(name), `${name} removed by default`);
    });
  }

  // L2. DuckDuckGo iai is the image, video or place opened in the detail pane. The research
  // lists it as view state and the rule removed it, while Google imgrc, Bing id and mediaurl
  // and Yandex img_url and pos, which do the same, are kept. The fixer pass kept it; Marcos
  // reversed that on 10 October 2026 (spec decision 22): iai goes, ticked, under a plain
  // label, and the tab values stay.
  for (const [link, clean] of [
    ['https://duckduckgo.com/?q=cat&ia=images&iax=images&iai=https%3A%2F%2Fexample.com%2Fcat.jpg', 'https://duckduckgo.com/?q=cat&ia=images&iax=images'],
    ['https://duckduckgo.com/?q=x&ia=videos&iax=videos&iai=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ', 'https://duckduckgo.com/?q=x&ia=videos&iax=videos'],
    ['https://duckduckgo.com/?q=cafe&iaxm=maps&bbox=5.2,60.5,5.4,60.3&iai=abc123', 'https://duckduckgo.com/?q=cafe&iaxm=maps&bbox=5.2,60.5,5.4,60.3'],
  ]) {
    test(`L2 reversed: ${link.slice(23, 80)} drops the opened item (iai), ticked, with a plain label`, () => {
      const r = A(link);
      const p = r.parts.find((x) => x.name === 'iai');
      assert.deepEqual(
        [p.provider, p.reveals, p.defaultRemove, p.ask, p.unrecognised, p.unique, p.rule],
        ['DuckDuckGo side-panel item', 'Which item was open in the side panel; the results are the same without it.', true, false, false, false, 'verified-page:duckduckgo-search'],
      );
      assert.equal(r.cleanLink, clean);
      assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== p.id)), link, 'unticking iai keeps it byte for byte');
    });
  }

  // L3. Yandex Video opens one video in the player with filmId; the research does not list it,
  // so it goes as Unrecognised.
  test('L3: Yandex Video keeps filmId', () => {
    const r = A('https://yandex.ru/video/search?text=fjord&path=wizard&parent-reqid=1234-abc&filmId=12345678901234567890');
    assert.ok(!removedNames(r).includes('filmId'));
    assert.ok(removedNames(r).includes('parent-reqid'));
  });

  // L4. ghc and lq (the two values Marcos found surviving, spec 12) and the other search-box
  // telemetry were removed only on the canonical result paths, so on Bing's other verticals
  // they survived; the research describes them as search-box telemetry, not page values.
  // Marcos, 10 October 2026 (spec decision 20): a bing.com host rule removes the search-box
  // values (ghc, lq, ghsh, ghacc, ghpl) and the session IDs (cvid, sid) on every path.
  for (const [link, clean] of [
    ['https://www.bing.com/shop?q=headphones&FORM=SHOPTB&ghc=1&lq=0', 'https://www.bing.com/shop?q=headphones&FORM=SHOPTB'],
    ['https://www.bing.com/maps?q=bergen&ghc=1&lq=0&cvid=abc', 'https://www.bing.com/maps?q=bergen'],
  ]) {
    test(`L4: ${link.slice(20, 80)} drops ghc and lq`, () => {
      const r = A(link);
      assert.ok(removedNames(r).includes('ghc') && removedNames(r).includes('lq'), removedNames(r).join(','));
      for (const name of ['ghc', 'lq']) {
        const p = r.parts.find((x) => x.name === name);
        assert.deepEqual([p.provider, p.defaultRemove, p.unrecognised, p.family], ['Bing search-box value', true, false, 'Microsoft'], name);
      }
      assert.equal(r.cleanLink, clean);
    });
  }

  test('L4: every search-box and session value goes on the other Bing paths, under the same labels as on a result page', () => {
    const r = A('https://cn.bing.com/travel/search?q=bergen&m=flights&ghc=1&lq=0&ghsh=0&ghacc=0&ghpl=&cvid=5A1B&sid=2D8F');
    assert.deepEqual(removedNames(r), ['ghc', 'lq', 'ghsh', 'ghacc', 'ghpl', 'cvid', 'sid']);
    assert.deepEqual([...new Set(r.parts.filter((p) => ['cvid', 'sid'].includes(p.name)).map((p) => p.provider))], ['Bing session ID']);
    assert.equal(r.cleanLink, 'https://cn.bing.com/travel/search?q=bergen&m=flights');
  });

  test('L4: a Bing visual search drops the search-box values and still keeps its picture', () => {
    const r = A('https://www.bing.com/images/search?view=detailv2&iss=sbi&imgurl=https%3A%2F%2Fexample.com%2Fa.jpg&ghc=1&lq=0');
    assert.equal(r.cleanLink, 'https://www.bing.com/images/search?view=detailv2&iss=sbi&imgurl=https%3A%2F%2Fexample.com%2Fa.jpg');
  });

  test('L4: the suggestion values stay limited to search, so a Bing Maps pin (sp) stays', () => {
    const r = A('https://www.bing.com/maps?cp=60.39~5.32&lvl=12&sp=point.60.39_5.32_Bergen&ghc=1');
    assert.ok(!removedNames(r).includes('sp'), removedNames(r).join(','));
    assert.equal(r.cleanLink, 'https://www.bing.com/maps?cp=60.39~5.32&lvl=12&sp=point.60.39_5.32_Bergen');
  });

  // L5. The research: "Visual-search pages (iss=sbi or cbir=sbi with imgurl) depend on an
  // uploaded image and are not canonicalisable". The rule has no such unless, so the picture's
  // address goes as Unrecognised.
  test('L5: a Bing visual search keeps the address of its picture', () => {
    const r = A('https://www.bing.com/images/search?view=detailv2&iss=sbi&cbir=sbi&imgurl=https%3A%2F%2Fexample.com%2Fa.jpg');
    assert.ok(!removedNames(r).includes('imgurl'));
  });

  // L6. instagr.am is Instagram's own short host for the same posts; the sharer rule named
  // instagram.com only. Marcos, 10 October 2026 (spec decision 21): instagr.am joins it.
  test('L6: the sharer ID goes on instagr.am too', () => {
    const r = A('https://instagr.am/p/DABC123xyz/?mdxt=NTc4MTIwNjQ2YQ%3D%3D');
    assert.ok(removedNames(r).includes('mdxt'));
    const p = r.parts.find((x) => x.name === 'mdxt');
    assert.ok(p.sharer && !p.unique && p.provider === 'Instagram sharer ID');
    assert.equal(r.cleanLink, 'https://instagr.am/p/DABC123xyz/');
  });

  test('L6: exln goes on instagr.am too, in capitals as well, and the post keeps its path', () => {
    assert.equal(A('https://www.instagr.am/reel/DABC123xyz/?EXLN=NTc4MTIwNjQ2YQ%3D%3D&mdxt=NTc4MTIwNjQ2YQ%3D%3D').cleanLink, 'https://www.instagr.am/reel/DABC123xyz/');
  });
});

// == G. guards: checked in this review and right today ==

describe('batch 3 review: guards', () => {
  // Partner, install and affiliate codes, which the task asked to check against the research
  // (none is kept as functional).
  for (const [link, name] of [
    ['https://duckduckgo.com/?q=bergen&t=brave', 't'],
    ['https://search.yahoo.com/search?p=bergen&fr=mozff', 'fr'],
    ['https://search.yahoo.com/yhs/search?hspart=mozilla&hsimp=yhs-001&p=bergen&type=ff_def', 'hspart'],
    ['https://www.qwant.com/?q=bergen&t=web&client=brz-moz', 'client'],
    ['https://www.startpage.com/sp/search?query=bergen&segment=startpage.brave&pl=opensearch', 'segment'],
    ['https://www.startpage.com/sp/search?query=bergen&segment=startpage.brave&pl=opensearch', 'pl'],
    ['https://www.baidu.com/s?wd=bergen&tn=48020221_29_hao_pg&ie=utf-8', 'tn'],
    ['https://www.baidu.com/baidu?wd=bergen&tn=monline_3_dg&ie=utf-8', 'tn'],
    ['https://www.ecosia.org/search?q=bergen&tt=mzl&addon=firefox', 'tt'],
    ['https://search.brave.com/search?q=bergen&source=desktop', 'source'],
    ['https://yandex.ru/search/?text=bergen&lr=213&clid=2186621', 'clid'],
    ['https://www.google.com/search?q=bergen&client=firefox-b-d&channel=fs&rlz=1C1GCEA_enNO1000NO1000', 'client'],
    ['https://www.bing.com/search?q=bergen&PC=U531&FORM=CHROMN', 'PC'],
    ['https://search.naver.com/search.naver?where=nexearch&sm=top_hty&query=bergen', 'sm'],
  ]) {
    test(`partner code ${name} goes on ${new URL(link).hostname}`, () => {
      assert.ok(removedNames(A(link)).includes(name), removedNames(A(link)).join(','));
    });
  }

  test('Baidu tn stays when it chooses the vertical', () => {
    for (const tn of ['news', 'baiduadv', 'vsearch']) assert.ok(keptNames(A(`https://www.baidu.com/s?wd=bergen&tn=${tn}&pd=video`)).includes('tn'), tn);
    assert.ok(keptNames(A('https://image.baidu.com/search/index?tn=baiduimage&word=bergen')).includes('tn'));
  });

  // Pagination on every engine survives cleaning.
  for (const [link, clean] of [
    ['https://www.google.com/search?q=bergen&start=20&ved=x', 'https://www.google.com/search?q=bergen&start=20'],
    ['https://www.bing.com/search?q=bergen&first=11&FORM=PERE', 'https://www.bing.com/search?q=bergen&first=11'],
    ['https://uk.search.yahoo.com/search?p=bergen&b=8&pz=7&fr=yfp-t&pstart=2', 'https://uk.search.yahoo.com/search?p=bergen&b=8&pz=7'],
    ['https://yandex.ru/search/?text=bergen&p=2&clid=1', 'https://yandex.ru/search/?text=bergen&p=2'],
    ['https://html.duckduckgo.com/html/?q=bergen&s=30&dc=31&t=h_', 'https://html.duckduckgo.com/html/?q=bergen&s=30'],
    ['https://search.brave.com/videos?q=bergen&offset=2&source=web', 'https://search.brave.com/videos?q=bergen&offset=2'],
    ['https://www.startpage.com/sp/search?query=bergen&page=2&sc=abc', 'https://www.startpage.com/sp/search?query=bergen&page=2'],
    ['https://www.mojeek.com/search?q=bergen&s=11&theme=dark', 'https://www.mojeek.com/search?q=bergen&s=11'],
    ['https://www.ecosia.org/search?q=bergen&p=1&tt=mzl', 'https://www.ecosia.org/search?q=bergen&p=1'],
    ['https://www.baidu.com/s?wd=bergen&pn=10&usm=3&rsv_pq=x', 'https://www.baidu.com/s?wd=bergen&pn=10&usm=3'],
    ['https://search.naver.com/search.naver?ssc=tab.blog.all&query=bergen&sm=tab_pge&start=31', 'https://search.naver.com/search.naver?ssc=tab.blog.all&query=bergen&start=31'],
  ]) {
    test(`pagination stays on ${new URL(link).hostname}`, () => assert.equal(A(link).cleanLink, clean));
  }

  // Tabs and filters that choose what the page shows.
  for (const [link, clean] of [
    ['https://www.google.com/search?q=cat&tbm=isch&sa=X#imgrc=AbCdEf123&imgdii=XyZ', 'https://www.google.com/search?q=cat&tbm=isch#imgrc=AbCdEf123&imgdii=XyZ'],
    ['https://www.google.com/search?q=bergen&tbm=nws&source=lnt&tbs=sbd:1', 'https://www.google.com/search?q=bergen&tbm=nws&tbs=sbd:1'],
    ['https://www.bing.com/videos/search?q=fjord&view=detail&mid=ABCDEF&FORM=VIRE', 'https://www.bing.com/videos/search?q=fjord&view=detail&mid=ABCDEF'],
    ['https://duckduckgo.com/?q=cafe&iaxm=maps&bbox=5.2,60.5,5.4,60.3&t=h_', 'https://duckduckgo.com/?q=cafe&iaxm=maps&bbox=5.2,60.5,5.4,60.3'],
    ['https://www.qwant.com/?q=bergen&t=images&o=0%3A1234abcd&size=large&client=opensearch', 'https://www.qwant.com/?q=bergen&t=images&o=0%3A1234abcd&size=large'],
    ['https://yandex.ru/images/search?text=cat&pos=3&img_url=https%3A%2F%2Fexample.com%2Fcat.jpg&rpt=simage&source=serp', 'https://yandex.ru/images/search?text=cat&pos=3&img_url=https%3A%2F%2Fexample.com%2Fcat.jpg&rpt=simage'],
  ]) {
    test(`a tab or filter stays on ${new URL(link).hostname}${new URL(link).pathname}`, () => assert.equal(A(link).cleanLink, clean));
  }

  // Country domains, capitals and a trailing dot reach the rules.
  for (const [link, clean] of [
    ['https://www.google.com.br/search?q=gato&hl=pt-BR&sca_esv=abc', 'https://www.google.com.br/search?q=gato&hl=pt-BR'],
    ['https://WWW.GOOGLE.CO.UK./search?q=bergen&ved=abc', 'https://WWW.GOOGLE.CO.UK./search?q=bergen'],
    ['https://yandex.kz/search/?text=bergen&lr=162&clid=1', 'https://yandex.kz/search/?text=bergen&lr=162'],
    ['https://de.search.yahoo.com/search?p=bergen&fr=mcafee&type=E211DE0G0', 'https://de.search.yahoo.com/search?p=bergen'],
    ['https://www.bing.com/search?q=bergen&Form=QBRE&Pc=U531', 'https://www.bing.com/search?q=bergen'],
    ['https://no.linkedin.com/posts/marcos-povoa_some-title-activity-7381234567890123456-AbCd?utm_source=share&zzq=1', 'https://no.linkedin.com/posts/marcos-povoa_some-title-activity-7381234567890123456-AbCd'],
  ]) {
    test(`host form ${new URL(link).hostname} is covered`, () => assert.equal(A(link).cleanLink, clean));
  }

  test("LinkedIn: a reshare's highlight values still go (Marcos's M4)", () => {
    const base = 'https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/';
    assert.equal(A(`${base}?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7381234567890000000&highlightedUpdateType=SHARED_BY_YOUR_NETWORK&origin=SHARED_BY_YOUR_NETWORK`).cleanLink, base);
  });

  test('Instagram sharer IDs go on every Instagram page, in capitals too, and are tied to the sharer', () => {
    for (const link of [
      'https://www.instagram.com/reel/DABC123xyz/?igsh=MWx4dGZ3&mdxt=NTc4MTIwNjQ2YQ%3D%3D&exln=NTc4MTIwNjQ2YQ%3D%3D',
      'https://www.instagram.com/marcos.povoa/?mdxt=NTc4MTIwNjQ2YQ%3D%3D',
      'https://www.instagram.com/stories/marcos.povoa/1234567890123456789/?mdxt=NTc4MTIwNjQ2YQ%3D%3D',
      'https://www.instagram.com/p/DABC123xyz/?MDXT=NTc4MTIwNjQ2YQ%3D%3D',
    ]) {
      const r = A(link);
      const p = r.parts.find((x) => /^mdxt$/i.test(x.name));
      assert.ok(p && p.defaultRemove && p.sharer && !p.unique, link);
      assert.ok(!/mdxt|exln/i.test(r.cleanLink), r.cleanLink);
    }
  });

  test("a destination's own mdxt behind Instagram's link shim is left to that site", () => {
    assert.equal(A('https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F%3Fmdxt%3Dabc&e=AT0abc').cleanLink, 'https://example.com/?mdxt=abc');
  });

  test('an @ in the path is never a disguise', () => {
    for (const link of ['https://www.google.com/maps/@59.9,10.7,15z', 'https://medium.com/@someone/post-123', 'https://www.tiktok.com/@someone/video/7381234567890123456']) {
      assert.equal(disguise(A(link)), undefined, link);
    }
  });

  test('a disguise inside a wrapper is removed along with the wrapper, and a port stays', () => {
    assert.equal(A('https://www.google.com/url?q=https://bank.example@evil.example/&sa=D').cleanLink, 'https://evil.example/');
    assert.equal(A('https://google.com@evil.example:8443/x').cleanLink, 'https://evil.example:8443/x');
  });

  test('SearXNG instances that write their own form values are still recognised', () => {
    assert.equal(
      A('https://searx.be/search?q=bergen&category_general=1&language=en-GB&time_range=&safesearch=0&theme=simple').cleanLink,
      'https://searx.be/search?q=bergen&category_general=1&language=en-GB&time_range=&safesearch=0',
    );
    assert.equal(
      A('https://searx.be/search?q=bergen&categories=general&language=en-GB&safesearch=1&pageno=2&theme=simple&utm_source=x').cleanLink,
      'https://searx.be/search?q=bergen&categories=general&language=en-GB&safesearch=1&pageno=2',
    );
  });

  test('a Lens page with an empty q is left to the verified rules', () => {
    const link = 'https://www.google.com/search?vsrid=CL&lns_mode=un&udm=26&q=&lns_surface=26';
    assert.equal(A(link).cleanLink, link);
  });

  test('a Mojeek result page drops an API key', () => {
    assert.equal(A('https://www.mojeek.com/search?q=bergen&api_key=SECRETKEY123').cleanLink, 'https://www.mojeek.com/search?q=bergen');
  });
});
