// Adversarial engine cases for src/link-core.js (review of 10 October 2026). Run from the
// repository root with: node --test tests/
//
// Lens: links the engine breaks (functional parts removed, encoding changed, a provider
// rule firing on a look-alike host, wrappers unwrapped wrongly or not at all, fragments
// changed) and links it under-cleans for the big providers.
//
// Every test states the behaviour CheckLink should have. A test marked { todo: 'Fn ...' }
// fails today and documents a review finding (Fn is its number in the review); node --test
// runs it and prints the failure as TODO without failing the suite, so the suite stays
// green until the engine or the rules change. When a finding is fixed, remove its todo
// marker. Tests without a marker pass today and guard against regressions.
//
// Fixed on 10 October 2026 and unmarked: F1 to F9, F11 to F19 (F16 too: two different
// destinations in one parameter are no longer unwrapped). F10 (C20) settled 2026-10-10:
// Marcos chose to strip Amazon th, as the verified table does.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { analyse } from '../src/link-core.js';

const seen = [];
function A(input) {
  const r = analyse(input);
  seen.push(r);
  return r;
}

const names = (r) => r.parts.filter((p) => p.defaultRemove).map((p) => (p.where === 'fragment' ? `#${p.name}` : p.name)).sort();
const wrapperIds = (r) => r.wrappers.map((w) => w.id);
const warnIds = (r) => r.warnings.map((w) => w.id);
// What Go to opens: app.js goTarget() uses `a.openUrl(removed)`, which puts https:// in
// front only when the chosen clean link has no scheme of its own (review finding F1).
const goHost = (r, ids) => new URL(r.openUrl(ids)).hostname;

// == A. engine correctness ==

describe('adversarial: engine correctness', () => {
  test('A1 a bare www. wrapper, unwrapped: Go to opens the real host, not "https"', () => {
    const r = A('www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=D');
    assert.equal(r.cleanLink, 'https://example.com/page');
    assert.equal(goHost(r), 'example.com');
  });

  test('A2 a bare www. wrapper the person keeps: Go to opens the wrapper host', () => {
    const r = A('www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=D');
    assert.equal(goHost(r, []), 'www.google.com');
  });

  test('A3 an unwrapped address never carries a raw space', () => {
    const r = A('https://www.google.com/url?q=https://example.com/a%20b&sa=D');
    assert.ok(!r.cleanLink.includes(' '), `clean link has a raw space: ${JSON.stringify(r.cleanLink)}`);
    assert.equal(r.cleanLink, 'https://example.com/a%20b');
  });

  test('A4 non-UTF-8 escapes survive unwrapping instead of becoming U+FFFD', () => {
    const r = A('https://www.google.com/url?q=https://www.finn.no/search?q=%E6%F8%E5&sa=D');
    assert.ok(!r.cleanLink.includes('\uFFFD'));
    assert.equal(r.cleanLink, 'https://www.finn.no/search?q=%E6%F8%E5');
  });

  test('A5 a correctly double-encoded inner address keeps its own escapes', () => {
    const r = A('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%2520b%3Fx%3D1%2526y%26utm_source%3Dz&sa=D');
    assert.equal(r.cleanLink, 'https://example.com/a%20b?x=1%26y');
  });

  test('A6 the outer fragment is carried when the inner address has none (a browser keeps it across the redirect)', () => {
    assert.equal(A('https://www.google.com/url?q=https://example.com/page#section').cleanLink, 'https://example.com/page#section');
  });

  test('A7 an inner fragment encoded inside the wrapper is kept', () => {
    assert.equal(A('https://www.google.com/url?q=https://example.com/page%23sec&sa=D').cleanLink, 'https://example.com/page#sec');
  });

  test('A8 a fully qualified host with a trailing dot is still unwrapped', () => {
    assert.deepEqual(wrapperIds(A('https://www.google.com./url?q=https://bank.example/&sa=D')), ['google-url']);
  });

  test("A9 a closing ' that belongs to the query is kept when no quote opens before the link", () => {
    const input = "https://example.com/?q='test'";
    assert.equal(A(input).link, input);
  });

  test('A10 a trailing * that belongs to the query is kept', () => {
    const input = 'https://example.com/search?q=foo*';
    assert.equal(A(input).link, input);
  });

  test('A11 Markdown bold around a link is still trimmed', () => {
    const r = A('see **https://example.com/?utm_source=x** now');
    assert.equal(r.link, 'https://example.com/?utm_source=x');
    assert.equal(r.cleanLink, 'https://example.com/');
  });

  test('A12 "About:" written straight before a link is prose, not an about: address', () => {
    const r = A('About:https://www.youtube.com/watch?v=abc&si=xyz');
    assert.equal(r.found, true);
    assert.equal(r.cleanLink, 'https://www.youtube.com/watch?v=abc');
  });

  test('A13 a wrapper with two different destinations in the same parameter is not unwrapped silently', () => {
    const r = A('https://l.facebook.com/l.php?u=https%3A%2F%2Fbank.example%2F&u=https%3A%2F%2Fother.example%2F&h=AT0');
    assert.ok(r.wrappers.length === 0 || r.warnings.some((w) => w.tier === 'check'), 'either refuse to unwrap or warn');
  });

  test('A14 a long run of closing brackets is analysed quickly (20,000 is the input maxlength)', () => {
    const t0 = performance.now();
    A(`https://example.com/x${')'.repeat(20000)}`);
    assert.ok(performance.now() - t0 < 500, `took ${Math.round(performance.now() - t0)} ms`);
  });
});

// == B. look-alike hosts ==

describe('adversarial: look-alike hosts', () => {
  test('B1 a host that merely ends in "tradedoubler.com" is not Tradedoubler', () => {
    const r = A('https://clk.nottradedoubler.com/click?p=1&a=2&url=https%3A%2F%2Fbank.example%2F');
    assert.deepEqual(wrapperIds(r), []);
    assert.equal(r.host, 'clk.nottradedoubler.com');
  });

  test('B2 the real Tradedoubler host is still unwrapped', () => {
    assert.deepEqual(wrapperIds(A('https://clk.tradedoubler.com/click?p=1&a=2&url=https%3A%2F%2Fshop.example%2F')), ['tradedoubler']);
  });

  test('B3 google.com.de (com.de is a public suffix anyone can register under) is not Google', () => {
    const r = A('https://www.google.com.de/url?q=https://bank.example/&sa=D');
    assert.deepEqual(wrapperIds(r), []);
  });

  test('B4 amazon.co.com (co.com is a private public suffix) gets no Amazon rules', () => {
    assert.equal(A('https://www.amazon.co.com/dp/B0?tag=abc-20&ref=x').cleanLink, 'https://www.amazon.co.com/dp/B0?tag=abc-20&ref=x');
  });

  test('B5 amazon.com.evil.io gets no Amazon rules', () => {
    const input = 'https://www.amazon.com.evil.io/dp/B0/ref=sr_1_1?tag=x&th=1';
    assert.equal(A(input).cleanLink, input);
  });

  test('B6 youtube.com.evil.io keeps si', () => {
    const input = 'https://youtube.com.evil.io/watch?v=abc&si=xyz';
    assert.equal(A(input).cleanLink, input);
  });

  test('B7 l.facebook.com.evil.io/l.php is not the Facebook link shim', () => {
    assert.deepEqual(wrapperIds(A('https://l.facebook.com.evil.io/l.php?u=https%3A%2F%2Fbank.example%2F')), []);
  });

  test('B8 x.com.evil.io/i/redirect is not the X redirect', () => {
    assert.deepEqual(wrapperIds(A('https://x.com.evil.io/i/redirect?url=https%3A%2F%2Fbank.example%2F')), []);
  });

  test('B9 a user name of l.facebook.com before @ does not make a link shim', () => {
    const r = A('https://l.facebook.com@evil.example/l.php?u=https%3A%2F%2Fbank.example%2F');
    assert.deepEqual(wrapperIds(r), []);
    assert.equal(r.host, 'evil.example');
    assert.ok(warnIds(r).includes('at-trick'));
  });
});

// == C. functional parts that must stay ==

describe('adversarial: functional parts stay', () => {
  test('C1 a Django admin filter pk__in is not a Matomo pk_ parameter', () => {
    assert.equal(A('https://example.com/admin/shop/order/?pk__in=12%2C13&utm_source=x').cleanLink, 'https://example.com/admin/shop/order/?pk__in=12%2C13');
  });

  test('C2 Google Drive resourcekey stays', () => {
    assert.equal(A('https://drive.google.com/file/d/abc/view?usp=sharing&resourcekey=0-xyz&gclid=q').cleanLink, 'https://drive.google.com/file/d/abc/view?usp=sharing&resourcekey=0-xyz');
  });

  test('C3 OneDrive ?e= (the share check) stays', () => {
    const input = 'https://1drv.ms/w/s!AbC123?e=XyZ789';
    assert.equal(A(input).cleanLink, input);
  });

  test('C4 SharePoint ?e= stays while utm goes', () => {
    assert.equal(A('https://contoso.sharepoint.com/:w:/g/personal/x/EabC?e=Q1w2E3&utm_source=x').cleanLink, 'https://contoso.sharepoint.com/:w:/g/personal/x/EabC?e=Q1w2E3');
  });

  test('C5 Dropbox rlkey stays', () => {
    const input = 'https://www.dropbox.com/scl/fi/abc/file.pdf?rlkey=xyz123&dl=0';
    assert.equal(A(input).cleanLink, input);
  });

  test('C6 a Teams meeting context stays', () => {
    const input = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d';
    assert.equal(A(input).cleanLink, input);
  });

  test('C7 a Zoom pwd stays', () => {
    assert.equal(A('https://us02web.zoom.us/j/123456789?pwd=AbCdEf123&utm_source=x').cleanLink, 'https://us02web.zoom.us/j/123456789?pwd=AbCdEf123');
  });

  test('C8 Google Maps directions keep every part', () => {
    const input = 'https://www.google.com/maps/dir/?api=1&origin=Bergen&destination=Oslo&travelmode=driving';
    assert.equal(A(input).cleanLink, input);
  });

  test('C9 a YouTube playlist keeps list, index and t; si and pp go', () => {
    assert.equal(A('https://www.youtube.com/watch?v=abc&list=PLx&index=3&t=42&pp=iAQB&si=zz').cleanLink, 'https://www.youtube.com/watch?v=abc&list=PLx&index=3&t=42');
  });

  test('C10 a Facebook album (/media/set/?set=) keeps set', () => {
    const input = 'https://www.facebook.com/media/set/?set=a.123&type=3';
    assert.equal(A(input).cleanLink, input);
  });

  test('C11 an Amazon search keeps k, i and rh once /ref= goes from the path', () => {
    assert.equal(A('https://www.amazon.com/s/ref=nb_sb_noss?k=lego&i=toys&rh=n%3A165793011').cleanLink, 'https://www.amazon.com/s?k=lego&i=toys&rh=n%3A165793011');
  });

  test('C12 an eBay search keeps _nkw, _sacat, rt and LH_BIN', () => {
    assert.equal(A('https://www.ebay.com/sch/i.html?_nkw=lego&_sacat=0&_from=R40&_trksid=p2334524.m570.l1313&rt=nc&LH_BIN=1').cleanLink, 'https://www.ebay.com/sch/i.html?_nkw=lego&_sacat=0&rt=nc&LH_BIN=1');
  });

  test('C13 Google Images keep the selected image in the fragment', () => {
    assert.equal(A('https://www.google.com/search?q=x&tbm=isch&sa=X&ved=abc#imgrc=AbCdEf&imgdii=XyZ').cleanLink, 'https://www.google.com/search?q=x&tbm=isch#imgrc=AbCdEf&imgdii=XyZ');
  });

  test('C14 Google Jobs keep ibp and htidocid', () => {
    assert.equal(A('https://www.google.com/search?q=jobs&ibp=htl;jobs&htidocid=abc&sa=X&ved=123').cleanLink, 'https://www.google.com/search?q=jobs&ibp=htl;jobs&htidocid=abc');
  });

  test('C15 a Spotify episode keeps its start time', () => {
    assert.equal(A('https://open.spotify.com/episode/abc?si=def&t=120').cleanLink, 'https://open.spotify.com/episode/abc?t=120');
  });

  test('C16 a WhatsApp message text stays, encoding included', () => {
    assert.equal(A('https://wa.me/4712345678?text=Hei%20der&utm_source=x').cleanLink, 'https://wa.me/4712345678?text=Hei%20der');
  });

  test('C17 a Telegram bot start code stays; the referral goes', () => {
    assert.equal(A('https://t.me/examplebot?start=abc123&ref=xyz').cleanLink, 'https://t.me/examplebot?start=abc123');
  });

  test('C18 PDF open parameters in the fragment stay', () => {
    assert.equal(A('https://example.com/doc.pdf?utm_source=x#page=5&zoom=100').cleanLink, 'https://example.com/doc.pdf#page=5&zoom=100');
  });

  test('C19 a Google Books link (sig without sv) is not treated as an Azure signed link', () => {
    const r = A('https://books.google.no/books?id=abc&pg=PA12&dq=fjord&ots=x1&sig=AbCd&hl=en&sa=X&ved=2ahUKE');
    assert.equal(r.untouched, null);
  });

  test('C20 Amazon th goes, psc stays (Marcos 2026-10-10: strip th, as the verified table does)', () => {
    assert.equal(A('https://www.amazon.com/dp/B0ABC?th=1&psc=1').cleanLink, 'https://www.amazon.com/dp/B0ABC?psc=1');
  });
});

// == D. big providers: what must go ==

describe('adversarial: big providers are cleaned', () => {
  test('D1 TikTok: the search terms (q) and the timestamp (t) carried to a video go', () => {
    // A video page is fully addressed by its path (canonical rule tiktok-video, added after
    // Marcos's Instagram test of 10 October 2026). The verified table strips t as the search
    // timestamp on /search only; t is a protected short name, so it was shown unticked
    // (canonical review finding C5). Marcos, 10 October 2026 (spec decision 23): on a video
    // or photo page t goes, ticked, under its own plain label rather than as Unrecognised.
    // Unticking it keeps it byte for byte.
    const r = A('https://www.tiktok.com/@user/video/123?q=secret%20search&t=1700000000');
    assert.equal(r.cleanLink, 'https://www.tiktok.com/@user/video/123');
    assert.equal(r.parts.find((p) => p.name === 'q').unrecognised, false, 'q is the verified tracker, with its own label');
    const t = r.parts.find((p) => p.name === 't');
    assert.deepEqual(
      [t.provider, t.unrecognised, t.ask, t.defaultRemove, t.unique, t.rule],
      ['TikTok timestamp', false, false, true, false, 'verified-page:tiktok-video'],
    );
    assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== t.id)), 'https://www.tiktok.com/@user/video/123?t=1700000000');
  });

  test('D2 TikTok: q stays on /search', () => {
    assert.equal(A('https://www.tiktok.com/search?q=fjord&t=1700000000000').cleanLink, 'https://www.tiktok.com/search?q=fjord');
  });

  test('D3 LinkedIn /safety/go is unwrapped', () => {
    const r = A('https://www.linkedin.com/safety/go?url=https%3A%2F%2Fexample.com%2F&trk=flagship-messaging-web&messageThreadUrn=urn%3Ali');
    assert.equal(r.cleanLink, 'https://example.com/');
  });

  test('D4 the Threads link shim is unwrapped', () => {
    assert.equal(A('https://l.threads.net/?u=https%3A%2F%2Fexample.com%2F&e=AT0abc').cleanLink, 'https://example.com/');
  });

  test('D5 the Facebook link warning page is unwrapped', () => {
    assert.equal(A('https://www.facebook.com/flx/warn/?u=https%3A%2F%2Fexample.com%2F&h=AT0abc').cleanLink, 'https://example.com/');
  });

  test('D6 an Amazon email redirect (/gp/r.html?U=) is unwrapped', () => {
    const r = A('https://www.amazon.com/gp/r.html?C=2ABC&K=3XYZ&M=urn:rtn:msg:2024&R=1ABC&T=C&U=https%3A%2F%2Fwww.amazon.com%2Fdp%2FB0ABC%3Fref_%3Dpe_123&H=ABCDEF&ref_=pe_123');
    assert.equal(r.cleanLink, 'https://www.amazon.com/dp/B0ABC');
  });

  test('D7 Microsoft Teams Safe Links are unwrapped', () => {
    assert.equal(A('https://statics.teams.cdn.office.net/evergreen-assets/safelinks/1/atp-safelinks.html?url=https%3A%2F%2Fexample.com%2F&locationOfClick=19').cleanLink, 'https://example.com/');
  });

  test('D8 the AMP cache viewer path (/v/s/) is unwrapped', () => {
    assert.deepEqual(wrapperIds(A('https://www-example-com.cdn.ampproject.org/v/s/www.example.com/article?amp_js_v=0.1')), ['amp-cache']);
  });

  test('D9 Google AMP viewer parameters (usqp, aoh) go after unwrapping', () => {
    const r = A('https://www-example-com.cdn.ampproject.org/c/s/www.example.com/article?usqp=mq331AQFKAGwASA%3D#aoh=16900000000000&referrer=https%3A%2F%2Fwww.google.com');
    assert.ok(names(r).includes('usqp') && names(r).includes('#aoh'), names(r).join(' '));
  });

  test('D10 youtube-nocookie.com: si goes', () => {
    assert.equal(A('https://www.youtube-nocookie.com/embed/abc?si=XYZ123abc').cleanLink, 'https://www.youtube-nocookie.com/embed/abc');
  });

  test('D11 Microsoft OCID in capitals goes, as ocid does', () => {
    assert.equal(A('https://www.microsoft.com/en-us/microsoft-365?OCID=AID2200057_SEM_abc&msclkid=abc123').cleanLink, 'https://www.microsoft.com/en-us/microsoft-365');
  });

  test('D12 Bing FORM in capitals goes, as form does', () => {
    assert.equal(A('https://www.bing.com/search?q=test&FORM=HDRSC1&qs=n').cleanLink, 'https://www.bing.com/search?q=test');
  });

  test('D13 a QR link stored all in capitals loses its UTM_ parameters', () => {
    assert.equal(A('HTTPS://EXAMPLE.COM/?UTM_SOURCE=QR&UTM_MEDIUM=PRINT').cleanLink, 'HTTPS://EXAMPLE.COM/');
  });

  test('D14 Google Maps entry=ttu goes on google.co.uk as on google.com', () => {
    assert.equal(A('https://www.google.co.uk/maps/place/X/@51,0,15z?entry=ttu&g_ep=EgoyMDI0').cleanLink, 'https://www.google.co.uk/maps/place/X/@51,0,15z');
  });

  test('D15 Pinterest invite_code and sender (the sharer) go', () => {
    assert.equal(A('https://www.pinterest.com/pin/123456/?invite_code=ab12cd&sender=987654321&sfo=1').cleanLink, 'https://www.pinterest.com/pin/123456/');
  });

  test('D16 a recipient token goes on an ordinary page whose campaign name mentions opt-out', () => {
    assert.equal(A('https://example.com/blog?utm_campaign=optout_reminder&_hsenc=p2ANqtz-abc&mc_eid=12345abc').cleanLink, 'https://example.com/blog');
  });

  test('D17 a recipient token still stays on a real unsubscribe page', () => {
    const r = A('https://example.com/email/unsubscribe?mc_eid=abc123&utm_source=x');
    assert.equal(r.cleanLink, 'https://example.com/email/unsubscribe?mc_eid=abc123');
    assert.ok(warnIds(r).includes('recipient-token'));
  });

  test('D18 a sign-in code in a route fragment (#/callback?code=) still gets the account warning', () => {
    const r = A('https://app.example.com/?utm_source=x#/callback?code=abc123&state=xyz');
    assert.ok(r.untouched || r.warnings.some((w) => /sign-in|account/.test(w.text)), warnIds(r).join(' '));
  });

  test('D19 Safe Links around YouTube: wrapper and si go', () => {
    const r = A('https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc%26si%3Dxyz&data=05%7C02%7Cme%40example.com&sdata=abc&reserved=0');
    assert.equal(r.cleanLink, 'https://www.youtube.com/watch?v=abc');
    assert.deepEqual(wrapperIds(r), ['outlook-safelinks']);
  });

  test('D20 a Google result link (empty q, url=) unwraps to url and cleans it', () => {
    assert.equal(A('https://www.google.com/url?sa=t&rct=j&q=&esrc=s&source=web&cd=&ved=2ah&url=https%3A%2F%2Fwww.example.com%2F%3Futm_source%3Dgoogle%26id%3D5&usg=AOv').cleanLink, 'https://www.example.com/?id=5');
  });

  test('D21 an Instagram reel loses igsh and utm_source', () => {
    assert.equal(A('https://www.instagram.com/reel/ABC/?igsh=MTc4&utm_source=ig_web_copy_link').cleanLink, 'https://www.instagram.com/reel/ABC/');
  });

  test('D22 a Reddit app share loses share_id and every utm_', () => {
    assert.equal(A('https://www.reddit.com/r/x/comments/abc/title/?share_id=xyz&utm_content=1&utm_medium=android_app&utm_name=androidcss&utm_source=share&utm_term=1').cleanLink, 'https://www.reddit.com/r/x/comments/abc/title/');
  });

  test('D23 a LinkedIn job keeps currentJobId and loses the tracking', () => {
    assert.equal(A('https://www.linkedin.com/jobs/view/123/?alternateChannel=search&refId=abc&trackingId=xyz&trk=d_flagship3_search_srp_jobs&currentJobId=123').cleanLink, 'https://www.linkedin.com/jobs/view/123/?currentJobId=123');
  });

  test('D24 an eBay app share comes back bare', () => {
    assert.equal(A('https://www.ebay.co.uk/itm/123?mkcid=16&mkevt=1&mkrid=711-127632-2357-0&ssspo=abc&sssrc=2524149&ssuid=xyz&widget_ver=artemis&media=COPY').cleanLink, 'https://www.ebay.co.uk/itm/123');
  });

  test('D25 an Amazon affiliate product link keeps only psc', () => {
    const r = A('https://www.amazon.com/dp/B0ABC/ref=sr_1_1?tag=abc-20&keywords=lego&qid=1&sr=8-1&psc=1&linkCode=ll1&ref_=as_li_ss_tl');
    assert.equal(r.cleanLink, 'https://www.amazon.com/dp/B0ABC?psc=1');
  });

  test('D26 a Bing result link (u=a1 base64) is decoded and its utm goes', () => {
    assert.equal(A('https://www.bing.com/ck/a?!&&p=abc&ptn=3&ver=2&hsh=3&fclid=xyz&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8_dXRtX3NvdXJjZT1iaW5n&ntb=1').cleanLink, 'https://example.com/');
  });

  test('D27 a Google search keeps only q', () => {
    assert.equal(A('https://www.google.com/search?q=hello&rlz=1C1&oq=hello&gs_lcrp=EgZ&sourceid=chrome&ie=UTF-8').cleanLink, 'https://www.google.com/search?q=hello');
  });

  test('D28 Steam link filter is unwrapped', () => {
    assert.equal(A('https://steamcommunity.com/linkfilter/?url=https://example.com/').cleanLink, 'https://example.com/');
  });
});

// == invariants over every analysis above ==

describe('adversarial: invariants', () => {
  test('segments cover the link and clean() equals the kept segments for every single choice', () => {
    for (const r of seen) {
      if (!r.found) continue;
      assert.equal(r.segments.map((s) => s.text).join(''), r.link, r.link);
      const choices = [undefined, [], r.parts.map((p) => p.id), ...r.parts.map((p) => r.defaultRemoved.filter((id) => id !== p.id))];
      for (const ids of choices) {
        const segs = r.segmentsFor(ids);
        assert.equal(segs.map((s) => s.text).join(''), r.link, r.link);
        if (!r.wrappers.length) assert.equal(r.clean(ids), segs.filter((s) => !s.removed).map((s) => s.text).join(''), r.link);
      }
    }
  });

  test('with nothing removed the link comes back byte for byte', () => {
    for (const r of seen) if (r.found) assert.equal(r.clean([]), r.link);
  });
});
