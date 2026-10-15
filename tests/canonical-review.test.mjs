// Adversarial review of the canonical-page rules (rules/extra-rules.json canonical, 10
// October 2026). Run from the repository root with: node --test tests/
//
// Lens: over-cleaning. A canonical rule removes every parameter no verified rule names, so
// the review hunts for parameters on those page types that do something and now go by
// default; for host and path patterns that match too much; and for the interaction with
// wrappers, fragments, capitals, trailing slashes and links left untouched.
//
// Same convention as tests/adversarial.test.mjs: a test marked { todo: 'Cn ...' } fails
// today and documents review finding Cn; node --test prints it as TODO without failing the
// suite. When a finding is fixed, remove its todo marker. Tests without a marker pass today
// and guard the behaviour the review confirmed as right.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { analyse } from '../src/link-core.js';
import { RULES } from '../src/rules.js';

const A = (s) => analyse(s);
const part = (r, name) => r.parts.find((p) => p.name === name);
const removedNames = (r) => r.parts.filter((p) => r.defaultRemoved.includes(p.id)).map((p) => p.name);
const unrecognised = (r) => r.parts.filter((p) => p.unrecognised);
const keptNames = (r) => r.kept.map((k) => k.name);

// == C. findings (todo until fixed) ==

describe('canonical review: findings', () => {
  // C1. Language selectors. hl and lang are on the spec's own protected list ("Never removed
  // on every site"), and Amazon writes ?language=en_US into its own navigation links. On
  // these pages they choose the language the same post or product is shown in; the reveals
  // text "This page opens without it" is true but the page opens in another language.
  for (const [link, name] of [
    ['https://www.instagram.com/p/DeTqc0NDifd/?hl=pt-br&mdxt=NTc4MTIwNjQ2YQ==', 'hl'],
    ['https://www.threads.net/@stormberry.as/post/C9xYz12AbCd?hl=nb&xmt=AQGz', 'hl'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ?hl=pt&si=AbCdEf12', 'hl'],
    ['https://x.com/stormberry/status/1844000000000000000?lang=nb&s=20', 'lang'],
    ['https://www.amazon.de/dp/B07XJ8C8F5?language=en_GB&tag=x-21', 'language'],
  ]) {
    test(`C1 the language selector ${name} stays on ${new URL(link).hostname}`, () => {
      const r = A(link);
      assert.ok(!removedNames(r).includes(name), `${name} is removed by default: ${r.cleanLink}`);
      assert.ok(r.cleanLink.includes(`${name}=`), r.cleanLink);
    });
  }

  // C2. A text highlight written after an ordinary fragment (Chrome's "Copy link to
  // highlight" keeps an existing #anchor and adds :~:text=). paramFragment() reads
  // "customerReviews:~:text=battery" as one key=value pair, and the canonical rule removes
  // it, anchor and highlight together. The spec lists removing text highlights as an
  // optional extra not asked for, and the verified table (fragment-text) says keep.
  for (const link of [
    'https://www.amazon.com/dp/B07XJ8C8F5#customerReviews:~:text=battery',
    'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?si=abc#about:~:text=lyrics',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ#comments:~:text=great',
  ]) {
    test(`C2 the text highlight after #anchor stays: ${link.slice(0, 60)}`, () => {
      const r = A(link);
      assert.ok(r.cleanLink.includes(':~:text='), r.cleanLink);
      assert.equal(unrecognised(r).filter((p) => p.where === 'fragment').length, 0);
    });
  }

  test('C2 control: a highlight written alone (#:~:text=) already stays', () => {
    assert.equal(A('https://www.amazon.com/dp/B07XJ8C8F5#:~:text=battery').cleanLink, 'https://www.amazon.com/dp/B07XJ8C8F5#:~:text=battery');
  });

  // C3. Spotify parameters that change what the item page does. highlight=spotify:track:<id>
  // marks one track on an album or playlist page; pt= is the collaborator invite on a
  // playlist link made by "Invite collaborators" (?si=...&pt=...&pi=...): without it the
  // link opens the playlist but not the invitation.
  // Fixed in batch 3 (10 October 2026): highlight is on the spotify-item keep list.
  test('C3 Spotify highlight (the track marked on an album page) stays', () => {
    const r = A('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?highlight=spotify:track:0PsBajvo0g7bLLHxwH3Sk0&si=abc');
    assert.equal(r.cleanLink, 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?highlight=spotify:track:0PsBajvo0g7bLLHxwH3Sk0');
  });

  test('C3 Spotify pt (the collaborator invite) is not removed by default', () => {
    const r = A('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc&pt=def123&pi=ghi');
    assert.ok(!removedNames(r).includes('pt'), r.cleanLink);
    assert.deepEqual(removedNames(r).sort(), ['pi', 'si']);
  });

  // C4. Amazon product-page parameters that change the view: aod=1 opens the All Offers
  // Display panel (other sellers); m= is the merchant, which the verified table keeps on /s
  // as the seller filter and whose removal DandelionSprout disabled.
  // Fixed in batch 3 (10 October 2026): aod and m are on the amazon-product keep list.
  test('C4 Amazon aod (opens the other-offers panel) stays', () => {
    const r = A('https://www.amazon.co.uk/dp/B08N5WRWNW?aod=1&tag=x-21');
    assert.equal(r.cleanLink, 'https://www.amazon.co.uk/dp/B08N5WRWNW?aod=1');
  });

  test('C4 Amazon m (merchant) is not removed by default on a product page', () => {
    const r = A('https://www.amazon.com/dp/B07XJ8C8F5?m=ATVPDKIKX0DER');
    assert.ok(!removedNames(r).includes('m'), r.cleanLink);
    assert.equal(r.cleanLink, 'https://www.amazon.com/dp/B07XJ8C8F5?m=ATVPDKIKX0DER');
    assert.ok(keptNames(r).includes('m'));
  });

  // C5. Every protected short name except those a site's own rules or functional_keep
  // entries cover is removed by default on these pages, with no build guard. The build
  // refuses a GLOBAL rule that would do this; a canonical rule does it per site for names
  // nobody has checked (TikTok t on a video is test D1, which the build note flagged as a
  // decision for Marcos; his decision 23 of 10 October 2026 puts t on that page's remove
  // list, with its own label, so it is no longer an Unrecognised part).
  test('C5 a protected short name on a canonical page is shown but not ticked by default', () => {
    const pages = [
      'https://www.instagram.com/p/DeTqc0NDifd/',
      'https://www.threads.net/@user/post/C9xYz12AbCd',
      'https://x.com/user/status/1844000000000000000',
      'https://www.tiktok.com/@user/video/7420000000000000000',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0',
      'https://www.amazon.de/dp/B07XJ8C8F5',
    ];
    const offenders = [];
    for (const base of pages) {
      for (const n of RULES.protectedNames) {
        const r = A(`${base}?${n}=1`);
        const p = part(r, n);
        if (p && p.unrecognised && p.defaultRemove) offenders.push(`${new URL(base).hostname} ${n}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  // C6. functional_keep notes written for reviewers are now shown under "Kept on purpose",
  // but only on canonical pages (before, a name no rule named was never listed). The TikTok
  // note tells the reader not to copy Firefox's list because "it strips q and t on every
  // path", on the very page where CheckLink has just removed t. The corrections section
  // already reworded the Google notes for this reason.
  test('C6 "Kept on purpose" notes on canonical pages carry no reviewer jargon and do not contradict the result', () => {
    const notes = [];
    for (const link of [
      'https://www.tiktok.com/@user/video/7420000000000000000?lang=en&t=1700000000',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ?t=5',
      'https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?t=120&uri=spotify:episode:x',
    ]) for (const k of A(link).kept) notes.push(`${k.name}: ${k.note}`);
    assert.ok(notes.length >= 4);
    for (const n of notes) assert.doesNotMatch(n, /\bLUS\b|Tidy URL|Firefox|Do not copy|allow-list|verbatim/, n);
  });

  // C7. The same functional parameter is listed under "Kept on purpose" on one YouTube
  // address and silently kept on another, depending only on whether a canonical rule
  // covers the path.
  test('C7 YouTube t is listed the same way on youtu.be and on a Short', () => {
    const a = A('https://youtu.be/WgewEn1mFPs?si=x7DG-_JN6QGh1mJr&t=354');
    const b = A('https://www.youtube.com/shorts/dQw4w9WgXcQ?si=x7DG-_JN6QGh1mJr&t=354');
    assert.equal(keptNames(a).includes('t'), keptNames(b).includes('t'));
  });

  // C8. A name in capitals is matched to the verified rules in small letters (PSC stays,
  // UTM_SOURCE goes), but the canonical keep list and functional_keep are compared as
  // written, so IMG_INDEX and LANG go while img_index and lang stay.
  test('C8 the canonical keep list and functional_keep follow the capitals fallback too', () => {
    assert.ok(!removedNames(A('https://www.amazon.com/dp/B07XJ8C8F5?PSC=1')).includes('PSC'), 'control: PSC stays');
    assert.ok(!removedNames(A('https://www.instagram.com/p/DeTqc0NDifd/?IMG_INDEX=2')).includes('IMG_INDEX'));
    assert.ok(!removedNames(A('https://www.tiktok.com/@user/video/7420000000000000000?LANG=en')).includes('LANG'));
  });

  // C9. An Unrecognised part is "Unique to this click" whenever its value looks generated.
  // Base64 of a fixed word looks generated: almBrandId=QW1hem9uIEZyZXNo is "Amazon Fresh",
  // the same for everyone, and is badged as unique.
  test('C9 a base64 value that decodes to a plain word is not badged unique', () => {
    const p = part(A('https://www.amazon.com/dp/B07XJ8C8F5?almBrandId=QW1hem9uIEZyZXNo'), 'almBrandId');
    assert.equal(atob('QW1hem9uIEZyZXNo'), 'Amazon Fresh');
    assert.equal(p.unique, false);
  });
});

// == G. guards: what the review confirmed as right ==

describe('canonical review: verified-functional parameters survive', () => {
  for (const [link, names] of [
    ['https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?si=abc&go=1&nd=1&uri=spotify:track:x&t=30', ['go', 'nd', 'uri', 't']],
    ['https://www.tiktok.com/@user/video/7420000000000000000?lang=en&_r=1', ['lang']],
    ['https://www.amazon.de/dp/B07XJ8C8F5?th=1&psc=1&smid=A3JWKAKR8XB7XF&ie=UTF8', ['psc', 'smid', 'ie']],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share&t=5&list=PL1&index=2&lc=Ugx1&start=3&end=9', ['t', 'list', 'index', 'lc', 'start', 'end']],
    ['https://www.instagram.com/reel/C9xYz12AbCd/?img_index=2&igsh=abc', ['img_index']],
  ]) {
    test(`kept on ${new URL(link).hostname}: ${names.join(', ')}`, () => {
      const r = A(link);
      for (const n of names) {
        assert.ok(!removedNames(r).includes(n), `${n} removed: ${r.cleanLink}`);
        assert.ok(r.cleanLink.includes(`${n}=`), `${n} missing from ${r.cleanLink}`);
      }
    });
  }

  test('verified trackers on canonical pages keep their own labels (YouTube feature, Amazon th, X t on /i/status/)', () => {
    for (const [link, name] of [
      ['https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share', 'feature'],
      ['https://www.amazon.de/dp/B07XJ8C8F5?th=1', 'th'],
      ['https://x.com/i/status/1844000000000000000?t=AbCd', 't'],
    ]) {
      const p = part(A(link), name);
      assert.equal(p.unrecognised, false, link);
      assert.ok(!p.rule.startsWith('canonical:'), link);
    }
  });
});

describe('canonical review: hosts and paths that must not match', () => {
  const untouchedByCanonical = [
    // look-alike and neighbouring hosts
    'https://instagram.com.br/p/DeTqc0NDifd/?mystery=1',
    'https://www-instagram.com/p/DeTqc0NDifd/?mystery=1',
    'https://www.instagram.co/p/DeTqc0NDifd/?mystery=1',
    'https://l.instagram.com/p/DeTqc0NDifd/?mystery=1',
    'https://help.instagram.com/p/DeTqc0NDifd/?mystery=1',
    'https://threads.net.evil.io/@a/post/C9xYz12AbCd?mystery=1',
    'https://fxtwitter.com/a/status/1844000000000000000?mystery=1',
    'https://vm.tiktok.com/@a/video/7420000000000000000?mystery=1',
    'https://music.youtube.com/shorts/dQw4w9WgXcQ?mystery=1',
    'https://www.youtube-nocookie.com/shorts/dQw4w9WgXcQ?mystery=1',
    'https://spotify.link/track/0PsBajvo0g7bLLHxwH3Sk0?mystery=1',
    'https://music.amazon.de/dp/B07XJ8C8F5?mystery=1',
    'https://www.amazon.co.no/dp/B07XJ8C8F5?mystery=1',
    'https://www.amazon.com.evil.io/dp/B07XJ8C8F5?mystery=1',
    'https://evilamazon.com/dp/B07XJ8C8F5?mystery=1',
    // other paths on the covered hosts
    'https://www.instagram.com/p/DeTqc0NDifd/embed/?mystery=1',
    'https://www.instagram.com/p/DeTqc0NDifd/c/17900000000000000/?mystery=1',
    'https://www.instagram.com/reels/audio/1234567890123456/?mystery=1',
    'https://www.instagram.com/stormberry.as/reels/?mystery=1',
    'https://www.instagram.com/stories/highlights/17900000000000000/?mystery=1',
    'https://www.instagram.com/accounts/login/?next=%2Fp%2FDeTqc0NDifd%2F&mystery=1',
    'https://www.instagram.com/s/aGlnaGxpZ2h0OjE3OTAw?story_media_id=1&mystery=1',
    'https://www.instagram.com/P/DeTqc0NDifd/?mystery=1',
    'https://www.instagram.com/p/DeTqc0NDifd//?mystery=1',
    'https://x.com/stormberry/status/1844000000000000000/likes?mystery=1',
    'https://x.com/stormberry/status/1844000000000000000/photo/1/extra?mystery=1',
    'https://x.com/i/redirect?url=https%3A%2F%2Fexample.com%2F&t=abc&mystery=1',
    'https://x.com/intent/post?text=hi&mystery=1',
    'https://www.tiktok.com/@stormberry/live?mystery=1',
    'https://www.tiktok.com/t/ZT8abcdef/?mystery=1',
    'https://www.tiktok.com/embed/v2/7420000000000000000?mystery=1',
    'https://www.youtube.com/shorts/dQw4w9WgXcQx?mystery=1',
    'https://www.youtube.com/embed/dQw4w9WgXcQ?mystery=1',
    'https://www.youtube.com/live/dQw4w9WgXcQ?mystery=1',
    'https://open.spotify.com/embed/track/0PsBajvo0g7bLLHxwH3Sk0?utm_source=generator&theme=0',
    'https://open.spotify.com/user/stormberry/playlist/37i9dQZF1DXcBWIGoYBM5M?mystery=1',
    'https://open.spotify.com/socialsession/abc123?mystery=1',
    'https://open.spotify.com/blend/taste-match/abc?mystery=1',
    'https://www.amazon.com/gp/aw/d/B07XJ8C8F5?mystery=1',
    'https://www.amazon.com/gp/video/detail/B07XJ8C8F5?autoplay=1&t=120',
    'https://www.amazon.com/gp/offer-listing/B07XJ8C8F5?mystery=1',
    'https://www.amazon.com/sspa/click?ie=UTF8&spc=abc&url=%2Fdp%2FB07XJ8C8F5',
    'https://www.amazon.com/stores/page/ABCD?mystery=1',
    'https://www.amazon.com/dp/B07XJ8C8F5/reviews?mystery=1',
  ];
  for (const link of untouchedByCanonical) {
    test(`no Unrecognised part: ${link.slice(0, 90)}`, () => {
      const r = A(link);
      assert.equal(unrecognised(r).length, 0, r.parts.map((p) => p.name).join(','));
    });
  }

  test('the same host written in capitals, with a port or with a trailing dot is still covered', () => {
    for (const link of [
      'https://WWW.INSTAGRAM.COM/p/DeTqc0NDifd/?unknownid=1',
      'https://www.instagram.com:443/p/DeTqc0NDifd/?unknownid=1',
      'https://www.instagram.com./p/DeTqc0NDifd/?unknownid=1',
    ]) {
      const r = A(link);
      assert.equal(unrecognised(r).length, 1, link);
      assert.equal(r.cleanLink, link.replace('?unknownid=1', ''), 'cut out, the host left as written');
    }
  });

  test('a trailing slash is optional on every rule', () => {
    for (const link of [
      'https://x.com/a/status/1844000000000000000/?mystery=1',
      'https://www.tiktok.com/@a/video/7420000000000000000/?mystery=1',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ/?mystery=1',
      'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0/?mystery=1',
      'https://www.amazon.com/dp/B07XJ8C8F5/?mystery=1',
      'https://www.threads.net/@a/post/C9xYz12AbCd/?mystery=1',
    ]) assert.equal(A(link).cleanLink, link.replace('?mystery=1', ''), link);
  });

  test('a long path on a covered host is decided quickly', () => {
    const t0 = performance.now();
    A(`https://www.amazon.com/${'a'.repeat(200000)}/dp/B07XJ8C8F5?mystery=1`);
    A(`https://www.instagram.com/${'a.'.repeat(100000)}/p/DeTqc0NDifd/?mystery=1`);
    A(`https://www.amazon.com/${'x/'.repeat(50000)}dp/B07XJ8C8F5?mystery=1`);
    assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
  });
});

describe('canonical review: wrappers, fragments and links left untouched', () => {
  test('a Google redirect around a post: the wrapper and mdxt go; keeping the wrapper keeps it all byte for byte', () => {
    const s = 'https://www.google.com/url?q=https%3A%2F%2Fwww.instagram.com%2Fp%2FDeTqc0NDifd%2F%3Fmdxt%3DNTc4%26hl%3Den&sa=D';
    const r = A(s);
    assert.equal(r.wrappers.length, 1);
    assert.ok(part(r, 'mdxt').sharer, 'the verified sharer ID (spec decision 17)');
    assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== 'w0')), s);
  });

  test('an outer fragment carried through a wrapper is judged on the inner page', () => {
    const r = A('https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Fp%2FDeTqc0NDifd%2F&e=AT0#mdxt=abc');
    assert.equal(r.cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/');
  });

  test('YouTube t in the fragment of a Short stays (functional_keep), a plain #anchor stays', () => {
    assert.equal(A('https://www.youtube.com/shorts/dQw4w9WgXcQ#t=30').cleanLink, 'https://www.youtube.com/shorts/dQw4w9WgXcQ#t=30');
    assert.equal(A('https://www.amazon.com/dp/B07XJ8C8F5?mystery=1#customerReviews').cleanLink, 'https://www.amazon.com/dp/B07XJ8C8F5#customerReviews');
  });

  test('a web-app route in the fragment is never cleaned', () => {
    const s = 'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0#/route?mystery=1';
    assert.equal(A(s).cleanLink, s);
  });

  for (const [label, s, id] of [
    ['an Azure-style signature on a product page', 'https://www.amazon.com/dp/B07XJ8C8F5?sig=abc&se=2026-12-01&mystery=1', 'signed'],
    ['a sign-in value in capitals on a Short', 'https://www.youtube.com/shorts/dQw4w9WgXcQ?Token=abc&mystery=1', 'auth'],
    ['a sign-in value in the fragment of a post', 'https://www.instagram.com/p/DeTqc0NDifd/?mdxt=1#access_token=abc', 'auth'],
    ['a reset value in a fragment route on a status', 'https://x.com/a/status/1844000000000000000?mystery=1#/cb?code=abc', 'auth'],
  ]) {
    test(`${label} stays byte for byte`, () => {
      const r = A(s);
      assert.equal(r.untouched && r.untouched.id, id);
      assert.equal(r.cleanLink, s);
    });
  }

  test('an Amazon redirect endpoint skipped by functional_keep is never a canonical page', () => {
    const s = 'https://www.amazon.com/gp/slredirect/picassoRedirect.html?ie=UTF8&url=%2Fdp%2FB07XJ8C8F5&mystery=1';
    assert.equal(unrecognised(A(s)).length, 0);
  });
});
