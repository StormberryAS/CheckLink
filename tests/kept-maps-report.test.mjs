// Engine side of the interface build of 10 October 2026 (spec decisions 8, 10 and 15):
//   A. parameters kept on purpose carry an id, plain words and a "Remove anyway" choice;
//   B. a Google Maps place link whose data= carries context gets a neutral note and a
//      "Pin only" link built from the place's own coordinates, and a "Place only" link
//      built from its own feature ID (more in tests/place-only.test.mjs);
//   C. reportMail builds the "Did CheckLink break your link? Email us" mailto: address and
//      leaves out anything personal.
// The page side is in tests/ui-smoke.mjs and tests/e2e.mjs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RULES_DATE, analyse, clockTime, reportMail } from '../src/link-core.js';

const A = (s) => analyse(s);
const REG = Object.fromEntries(JSON.parse(readFileSync(new URL('../rules/marcos-regression.json', import.meta.url), 'utf8')).cases.map((c) => [c.id, c]));
const keptBy = (r, name) => r.kept.find((k) => k.name === name);
const NOT_YOU = 'It does not identify you.';
const mail = (r, ids) => {
  const m = reportMail(r, ids === undefined ? r.defaultRemoved : ids);
  const q = /^mailto:([^?]*)\?(.*)$/.exec(m.href);
  const params = q[2].split('&').map((x) => x.split('='));
  return { ...m, to: q[1], names: params.map((x) => x[0]), subject: decodeURIComponent(params[0][1]), body: decodeURIComponent(params[1][1]) };
};

// Wording rules for anything the page shows: no em or en dashes, no double hyphens, never
// "safe", British spelling, and never "your search".
function wordingOk(text, where) {
  assert.ok(!/[–—]|--/.test(text), `${where}: no dashes: ${text}`);
  assert.ok(!/\bsafe(ly|ty|r|st)?\b/i.test(text.replace(/Safe Links/g, '')), `${where}: never "safe": ${text}`);
  assert.ok(!/\b(color|organiz|gray|center|favorite|behavior|analyz|customiz|recogniz)/i.test(text), `${where}: British spelling: ${text}`);
  assert.ok(!/your search/i.test(text), `${where}: never "your search": ${text}`);
}

// ---------------------------------------------------------------------------------------
describe('A. kept on purpose', () => {
  test('clockTime reads seconds and h/m/s the way a clock shows them', () => {
    assert.equal(clockTime('354'), '5:54');
    assert.equal(clockTime('0'), '0:00');
    assert.equal(clockTime('45'), '0:45');
    assert.equal(clockTime('3723'), '1:02:03');
    assert.equal(clockTime('1h2m3s'), '1:02:03');
    assert.equal(clockTime('01h02m03s'), '1:02:03');
    assert.equal(clockTime('90s'), '1:30');
    assert.equal(clockTime('5m'), '5:00');
    assert.equal(clockTime('2h'), '2:00:00');
    for (const bad of ['', 'abc', '1x', 'h', '12:30', '-5', '1.5', '9999999']) assert.equal(clockTime(bad), null, bad);
  });

  test("Marcos's YouTube test (M2): t=354 is kept, explained as a start time at 5:54 that does not identify you", () => {
    const r = A(REG['M2-youtube-time'].dirty);
    const t = keptBy(r, 't');
    assert.equal(t.id, 'q1');
    assert.equal(t.value, '354');
    assert.equal(t.text, 't=354');
    assert.equal(t.reason, 'functional');
    assert.equal(t.explain, 'Start time: opens the video at 5:54. It does not identify you.');
    assert.equal(t.neutral, true);
    assert.equal(r.cleanLink, REG['M2-youtube-time'].clean);
  });

  test('a kept parameter is marked in the segments with its own id, and never removed by default', () => {
    const r = A(REG['M2-youtube-time'].dirty);
    const t = keptBy(r, 't');
    assert.ok(!r.defaultRemoved.includes(t.id));
    assert.ok(!r.parts.some((p) => p.id === t.id), 'not a part: it has no row among the parts');
    assert.ok(r.segments.some((s) => s.partId === t.id && !s.removed && s.text === 't=354'));
  });

  test('"Remove anyway": passing a kept id to clean() removes it, and the segments follow', () => {
    const r = A(REG['M2-youtube-time'].dirty);
    const t = keptBy(r, 't');
    const ids = [...r.defaultRemoved, t.id];
    assert.equal(r.clean(ids), 'https://youtu.be/WgewEn1mFPs');
    assert.ok(r.segmentsFor(ids).some((s) => s.partId === t.id && s.removed));
    assert.equal(r.clean([t.id]), 'https://youtu.be/WgewEn1mFPs?si=x7DG-_JN6QGh1mJr', 'only t, the share ID kept');
    assert.equal(r.clean([]), r.link, 'nothing removed gives the link back byte for byte');
  });

  test('the ids of parts and kept parameters never collide', () => {
    for (const c of Object.values(REG)) {
      const r = A(c.dirty);
      const ids = [...r.parts.map((p) => p.id), ...r.kept.map((k) => k.id)];
      assert.equal(new Set(ids).size, ids.length, c.id);
    }
  });

  test('the YouTube parameters each get their own plain words', () => {
    const r = A('https://www.youtube.com/watch?v=abc123&list=PL1&index=3&t=1h2m3s&si=xx');
    assert.equal(keptBy(r, 'v').explain, `Video: says which video opens. ${NOT_YOU}`);
    assert.equal(keptBy(r, 'list').explain, `Playlist: plays the video as part of a playlist. ${NOT_YOU}`);
    assert.equal(keptBy(r, 'index').explain, `Playlist position: which video of the playlist this is. ${NOT_YOU}`);
    assert.equal(keptBy(r, 't').explain, `Start time: opens the video at 1:02:03. ${NOT_YOU}`);
    assert.equal(keptBy(A('https://www.youtube.com/watch?v=abc&t=soon'), 't').explain, `Start time: where the video starts playing. ${NOT_YOU}`);
    assert.equal(keptBy(A('https://www.youtube.com/embed/abc?start=90&end=120'), 'start').explain, `Start time: the video starts at 1:30. ${NOT_YOU}`);
    assert.equal(keptBy(A('https://www.youtube.com/embed/abc?start=90&end=120'), 'end').explain, `End time: the video stops at 2:00. ${NOT_YOU}`);
  });

  test('the functional parameters of the spec read in plain words (Apple Music, Amazon, Netflix, Google Play, Twitch)', () => {
    assert.equal(keptBy(A('https://music.apple.com/no/album/x/123?i=456&uo=4'), 'i').explain, `Song or episode: picks the song on an album page, or the episode of a podcast. ${NOT_YOU}`);
    const amz = A('https://www.amazon.co.uk/dp/B0ABC?psc=1&smid=A1&tag=x-21');
    assert.equal(keptBy(amz, 'psc').explain, `Chosen option: keeps the size or colour that was chosen. ${NOT_YOU}`);
    assert.equal(keptBy(amz, 'smid').explain, `Seller: keeps the seller that was chosen. ${NOT_YOU}`);
    assert.equal(keptBy(A('https://www.netflix.com/browse?jbv=80057281'), 'jbv').explain, `Title: says which film or series opens. ${NOT_YOU}`);
    const play = A('https://play.google.com/store/search?q=maps&c=apps');
    assert.equal(keptBy(play, 'c').explain, `Search category: without it the search page can keep reloading. ${NOT_YOU}`);
    assert.equal(keptBy(A('https://www.twitch.tv/videos/123?t=01h02m03s'), 't').explain, `Start time: opens the past broadcast at 1:02:03. ${NOT_YOU}`);
  });

  test('a value that can point at someone is never called neutral: Telegram start, search words, recipient tokens, WhatsApp', () => {
    const tg = keptBy(A('https://t.me/somebot?start=ref_123'), 'start');
    assert.equal(tg.neutral, false);
    assert.match(tg.explain, /invite code, which can show who shared the link\.$/);
    for (const [link, name] of [['https://www.google.com/search?q=bag', 'q'], ['https://duckduckgo.com/?q=bag', 'q'], ['https://yandex.com/search/?text=bag', 'text'], ['https://www.amazon.com/s?k=bag', 'k'], ['https://play.google.com/store/search?q=maps&c=apps', 'q']]) {
      const k = keptBy(A(link), name);
      assert.equal(k.explain, 'The search itself. Everyone who gets this link can read what was searched for.', link);
      assert.equal(k.neutral, false, link);
    }
    const rec = keptBy(A('https://example.com/unsubscribe?mkt_tok=abc123&utm_source=x'), 'mkt_tok');
    assert.equal(rec.reason, 'recipient-token');
    assert.equal(rec.neutral, false);
    assert.equal(rec.explain, 'Kept because this unsubscribe or preferences page needs it. This part identifies you; do not share this link.');
    const wa = keptBy(A('https://wa.me/4790000000?text=hi'), 'text');
    assert.equal(wa.neutral, false);
    assert.equal(wa.explain, wa.note, 'explained by its rule\'s own note');
  });

  test('a recipient token can be removed anyway', () => {
    const r = A('https://example.com/unsubscribe?mkt_tok=abc123&utm_source=x');
    assert.equal(r.cleanLink, 'https://example.com/unsubscribe?mkt_tok=abc123');
    assert.equal(r.clean([...r.defaultRemoved, keptBy(r, 'mkt_tok').id]), 'https://example.com/unsubscribe');
  });

  test('only the curated wording claims "It does not identify you"; everything else uses its rule\'s note', () => {
    const links = [
      ...Object.values(REG).map((c) => c.dirty),
      'https://www.youtube.com/watch?v=abc&list=PL1&index=3&t=354&lc=xyz&loop=1&playlist=a,b',
      'https://www.google.com/search?q=bag&hl=en&tbm=isch&start=10',
      'https://www.bing.com/search?q=bag&setlang=en&first=11',
      'https://search.brave.com/search?q=bag&offset=1&tf=pw',
      'https://www.instagram.com/p/DeTqc0NDifd/?img_index=2&hl=en',
      'https://open.spotify.com/album/abc?highlight=spotify:track:xyz',
      'https://www.ebay.co.uk/itm/123?var=456&iid=789',
      'https://www.booking.com/hotel/no/x.html?checkin=2026-11-01&checkout=2026-11-02&group_adults=2',
    ];
    let neutral = 0;
    for (const link of links) {
      for (const k of A(link).kept) {
        assert.ok(k.explain, `${link} ${k.name}: explained`);
        assert.equal(k.neutral, k.explain.endsWith(NOT_YOU), `${link} ${k.name}`);
        if (!k.neutral) assert.ok(!k.explain.includes(NOT_YOU), `${link} ${k.name}`);
        if (k.neutral) neutral++;
        wordingOk(k.explain, `${link} ${k.name}`);
      }
    }
    assert.ok(neutral >= 8, 'the curated wording is used');
  });

  test('segments cover the link and clean() equals the kept segments for every choice of parts and kept parameters', () => {
    const links = [
      REG['M2-youtube-time'].dirty,
      'https://www.youtube.com/watch?v=abc&list=PL1&index=3&t=354&si=xx#t=10',
      'https://www.amazon.co.uk/dp/B0ABC?psc=1&th=1&smid=A1&tag=x-21',
      'https://example.com/unsubscribe?mkt_tok=abc123&utm_source=x',
      REG['M10b-duckduckgo-images-tab'].dirty,
      `https://www.google.com/url?q=${encodeURIComponent('https://www.youtube.com/watch?v=abc&t=5&si=x')}&sa=D`,
    ];
    for (const link of links) {
      const r = A(link);
      const ids = [...r.parts.filter((p) => p.where !== 'wrapper').map((p) => p.id), ...r.kept.map((k) => k.id)];
      assert.ok(ids.length <= 10, link);
      for (let mask = 0; mask < 1 << ids.length; mask++) {
        const choice = [...r.wrappers.map((w) => w.partId), ...ids.filter((_, i) => mask & (1 << i))];
        const segs = r.target.segmentsFor(choice);
        assert.equal(segs.map((s) => s.text).join(''), r.target.link, link);
        const cut = segs.filter((s) => !s.removed).map((s) => s.text).join('');
        assert.equal(cut, r.clean(choice), link);
        if (segs.some((s) => s.removed)) assert.ok(!/[?&#]$/.test(cut) && !/[?&]&|&#|\?#/.test(cut), cut);
      }
    }
  });

  test('a kept wrapper keeps everything inside it, kept parameters included', () => {
    const r = A(`https://www.google.com/url?q=${encodeURIComponent('https://www.youtube.com/watch?v=abc&t=5&si=x')}&sa=D`);
    const t = keptBy(r, 't');
    assert.ok(t, 'the address inside has its own kept parameters');
    assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== 'w0').concat(t.id)), r.link);
  });
});

// ---------------------------------------------------------------------------------------
const BOTH = 'https://www.google.com/maps/place/Kleppest%C3%B8+Senter/@60.4082364,5.2236848,16.92z/data=!4m19!1m2!2m1!1sShopping+centres!1m8!3m7!1s0x463cfcbfe8e268df:0x32570ae48bb050ad!2sKleppest%C3%B8!3b1!8m2!3d60.4107183!4d5.2258428!16zL20vMDJyenBx!3m5!1s0x463cfceb4b000b89:0x6e38337ba04f4524!8m2!3d60.4103774!4d5.2268809!16s%2Fg%2F122fpxb0';

describe('B. Google Maps context', () => {
  test("Marcos's first place link (M6): the category Maps suggested is named, the place's own pin is offered, the link is unchanged", () => {
    const r = A(REG['M6-google-maps-place'].dirty);
    assert.deepEqual(r.maps.context, [{ kind: 'category', name: 'Vacation rentals' }]);
    assert.deepEqual(r.maps.pin, { lat: '60.4211807', lng: '5.2337099', link: 'https://www.google.com/maps/@60.4211807,5.2337099,17z' });
    const w = r.warnings.find((x) => x.id === 'maps-context');
    assert.equal(w.tier, 'info');
    // Batch 3 interface review finding 11: neutral words that also cover typed words, no jargon, and a pointer to Pin only.
    assert.equal(w.text, "This map address also holds something Maps picked up on the way to this place: a category or search words ('Vacation rentals'). Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.");
    assert.equal(r.cleanLink, REG['M6-google-maps-place'].clean);
  });

  test("Marcos's second place link (M7): the place viewed earlier is named, decoded, and the pin is the place's own, not the earlier one", () => {
    const r = A(REG['M7-google-maps-trail'].dirty);
    assert.deepEqual(r.maps.context, [{ kind: 'place', name: 'Kleppestø' }]);
    assert.equal(r.maps.pin.link, 'https://www.google.com/maps/@60.4103774,5.2268809,17z');
    assert.equal(r.warnings.find((x) => x.id === 'maps-context').text, "This map address also holds something Maps picked up on the way to this place: a place viewed earlier ('Kleppestø'). Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.");
    assert.equal(r.cleanLink, REG['M7-google-maps-trail'].clean);
  });

  test('both kinds of context read as the spec words them', () => {
    const r = A(BOTH);
    assert.equal(r.warnings.find((x) => x.id === 'maps-context').text, "This map address also holds something Maps picked up on the way to this place: a category or search words ('Shopping centres') and a place viewed earlier ('Kleppestø'). Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.");
    assert.equal(r.maps.pin.link, 'https://www.google.com/maps/@60.4103774,5.2268809,17z');
  });

  test('the note is neutral: Good to know, never "your search", and it does not hide "No warning signs found"', () => {
    for (const link of [REG['M6-google-maps-place'].dirty, REG['M7-google-maps-trail'].dirty, BOTH]) {
      const r = A(link);
      const w = r.warnings.find((x) => x.id === 'maps-context');
      assert.equal(w.tier, 'info');
      wordingOk(w.text, link);
      assert.ok(!r.warnings.some((x) => x.tier !== 'info'), 'nothing to check on these');
    }
  });

  test('a place link with no context gets no note and no pin', () => {
    for (const link of [
      'https://www.google.com/maps/place/Bryggen/@60.3973,5.3245,17z/data=!3m1!4b1!4m6!3m5!1s0x463cfc1e5c0bd2b5:0x6b1b0e1f0c5f2f0a!8m2!3d60.3973!4d5.3245!16s%2Fg%2F11b6',
      'https://www.google.com/maps/place/Bryggen/@60.3973,5.3245,17z',
      'https://www.google.com/maps/@60.4,5.3,15z',
      'https://www.google.com/maps/search/pizza/@60.4,5.3,15z/data=!3m1!4b1',
    ]) {
      const r = A(link);
      assert.equal(r.maps, null, link);
      assert.ok(!r.warnings.some((x) => x.id === 'maps-context'), link);
    }
  });

  test('only Google: the same path on another host, or a look-alike, gets nothing', () => {
    const path = '/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sVacation+rentals!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2';
    for (const host of ['example.com', 'google.evil.io', 'notgoogle.com']) assert.equal(A(`https://${host}${path}`).maps, null, host);
    assert.ok(A(`https://www.google.no${path}`).maps, 'google.no counts');
    assert.ok(A(`https://maps.google.com${path}`).maps, 'maps.google.com counts');
  });

  test('a name with invisible characters is shown with visible marks; a long one is shortened', () => {
    const r = A('https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sHolm%E2%80%AEtsil!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2');
    assert.equal(r.maps.context[0].name, 'Holm[U+202E]tsil');
    const long = A(`https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1s${'Word+'.repeat(30)}!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2`);
    assert.ok(Array.from(long.maps.context[0].name).length <= 40);
  });

  test('coordinates outside the map give no pin, but the note stays', () => {
    const r = A('https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sCafes!3m4!1s0x1:0x2!8m2!3d99.4!4d5.2');
    assert.ok(r.maps);
    assert.equal(r.maps.pin, null);
  });

  test('a link left untouched is not looked at', () => {
    const r = A(`${REG['M6-google-maps-place'].dirty}&token=abc`);
    assert.ok(r.untouched);
    assert.equal(r.maps, null);
  });
});

// ---------------------------------------------------------------------------------------
describe('C. "Did CheckLink break your link? Email us"', () => {
  test('a mailto: to info@stormberry.as with only a subject and a body, both encoded', () => {
    const m = mail(A(REG['M2-youtube-time'].dirty));
    assert.ok(m.href.startsWith('mailto:info@stormberry.as?subject=CheckLink%3A%20a%20cleaned%20link%20broke&body='));
    assert.equal(m.to, 'info@stormberry.as');
    assert.deepEqual(m.names, ['subject', 'body']);
    assert.equal(m.subject, 'CheckLink: a cleaned link broke');
    assert.ok(!/[\s<>"]/.test(m.href), 'nothing unencoded');
  });

  test('the body: the reminder, the original as written, the clean link as shown, a place to say what went wrong, the rules date', () => {
    const r = A(REG['M2-youtube-time'].dirty);
    assert.equal(mail(r).body, [
      'Before you send: the original link may hold personal parts, such as a code that identifies you. You can edit them out of this message.',
      '',
      'Original link: https://youtu.be/WgewEn1mFPs?si=x7DG-_JN6QGh1mJr&t=354',
      "CheckLink's clean link: https://youtu.be/WgewEn1mFPs?t=354",
      'What went wrong (optional): ',
      '',
      '',
      `Rules dated ${RULES_DATE}`,
    ].join('\r\n'));
    const t = keptBy(r, 't');
    assert.match(mail(r, [...r.defaultRemoved, t.id]).body, /^CheckLink's clean link: https:\/\/youtu\.be\/WgewEn1mFPs$/m, 'the clean link as shown, after "Remove anyway"');
  });

  const leftOut = [
    ['a reset link (left untouched)', 'https://example.com/reset-password?token=abc123def456&utm_source=email', 'signin', 'abc123def456'],
    ['a signed link', 'https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Signature=abcdef123&utm_source=x', 'signed', 'abcdef123'],
    ['a URL Defense link', 'https://urldefense.com/v3/__https://example.com/__;!!abc!def$', 'wrapped', '!!abc!def'],
    ['a recipient token on an unsubscribe page', 'https://example.com/unsubscribe?mkt_tok=abc123zz&utm_source=x', 'recipient', 'abc123zz'],
    ['a LinkedIn sign-in token', 'https://www.linkedin.com/comm/feed/?otpToken=otp987654&midToken=mid1&trk=eml', 'signin', 'otp987654'],
    ['an email= address', 'https://example.com/x?email=me%40example.com&utm_source=x', 'email', 'me@example.com'],
    ['an email address anywhere after the host', 'https://example.com/u/someone%40example.org/profile?utm_source=x', 'email', 'someone'],
    ['a Mailchimp subscriber ID', 'https://example.com/a?mc_eid=sub55555&utm_source=x', 'recipient', 'sub55555'],
  ];
  for (const [what, link, why, secret] of leftOut) {
    test(`the original is left out, with the reason, for ${what}`, () => {
      const r = A(link);
      const m = mail(r);
      assert.equal(m.original, false);
      assert.equal(m.originalReason, why);
      assert.match(m.body, /^Original link: left out, because .+\. Add it yourself only if you are happy to share it\.$/m);
      assert.ok(!m.body.includes(secret) && !m.href.includes(encodeURIComponent(secret)), 'the personal part is nowhere in the message');
      assert.ok(!m.body.includes('Before you send'), 'no reminder about an original that is not there');
    });
  }

  test("Outlook Safe Links: the original (the recipient's email) is left out; the clean link to the real address goes in, until the wrapper is kept", () => {
    const sl = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://example.org/page?utm_source=x&a=1')}&data=05%7C01%7Cme%40corp.no%7Cabc&sdata=AbCdEf0123456789&reserved=0`;
    const r = A(sl);
    let m = mail(r);
    assert.equal(m.original, false);
    assert.equal(m.clean, true);
    assert.match(m.body, /^CheckLink's clean link: https:\/\/example\.org\/page\?a=1$/m);
    m = mail(r, []);
    assert.equal(m.clean, false, 'kept wrapper: the clean link is the Safe Links address');
    assert.ok(!/me@corp\.no|me%40corp\.no/.test(m.body + m.href));
  });

  test('a recipient token removed anyway lets the clean link go in', () => {
    const r = A('https://example.com/unsubscribe?mkt_tok=abc123zz&utm_source=x');
    const m = mail(r, [...r.defaultRemoved, keptBy(r, 'mkt_tok').id]);
    assert.equal(m.original, false);
    assert.equal(m.clean, true);
    assert.match(m.body, /^CheckLink's clean link: https:\/\/example\.com\/unsubscribe$/m);
  });

  test('the address disguise is not personal: both links go in', () => {
    const m = mail(A(REG['M8-at-trick-userinfo'].dirty));
    assert.equal(m.original, true);
    assert.match(m.body, /^Original link: http:\/\/convincing-business-related-page-name-pretending-to-be-on-google\.com@kaspersky\.com\/blog\/$/m);
    assert.match(m.body, /^CheckLink's clean link: http:\/\/kaspersky\.com\/blog\/$/m);
  });

  test('long links are shortened in the middle, said so, and the whole address stays under 1,800 characters', () => {
    const cases = [
      `https://www.apple.com/?${'awc&'.repeat(5000)}`.slice(0, 20000),
      `https://example.com/a?x=${'y'.repeat(5000)}&utm_source=z`,
      `https://example.com/${'ø'.repeat(4000)}?utm_source=z`,
      REG['M3-amazon-search'].dirty,
    ];
    for (const link of cases) {
      const r = A(link);
      for (const ids of [r.defaultRemoved, []]) {
        const m = mail(r, ids);
        assert.ok(m.href.length < 1800, `${m.href.length} for ${link.slice(0, 40)}`);
        if (m.shortened) assert.match(m.body, /\(shortened\): .*…/);
        assert.match(m.body, /What went wrong \(optional\):/);
        assert.match(m.body, new RegExp(`Rules dated ${RULES_DATE}$`));
      }
    }
    assert.equal(mail(A(cases[1]), []).shortened, true);
    assert.equal(mail(A(REG['M3-amazon-search'].dirty)).shortened, false, 'the Amazon link fits whole');
  });

  test('a stray surrogate in the link does not break the address', () => {
    const r = A('https://example.com/a\uD800b?utm_source=x');
    if (r.found) assert.doesNotThrow(() => reportMail(r, r.defaultRemoved));
  });

  test('nothing to report without a web address', () => {
    assert.equal(reportMail(A('hello there'), []), null);
    assert.equal(reportMail(A('javascript:alert(1)'), []), null);
  });

  test('the wording follows the house rules', () => {
    for (const link of [REG['M2-youtube-time'].dirty, ...leftOut.map((x) => x[1])]) wordingOk(mail(A(link)).body, link);
  });
});
