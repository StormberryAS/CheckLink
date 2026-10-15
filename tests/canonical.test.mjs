// Canonical-page rules (rules/extra-rules.json canonical, built into src/rules.js). Run from
// the repository root with: node --test tests/
//
// Marcos's test of 10 October 2026: an Instagram post link carried mdxt=, a parameter no
// list names, and CheckLink kept it. On a page fully addressed by its path, a parameter
// that no verified rule names, that the rule's keep list does not name and that no
// functional_keep entry keeps is now an Unrecognised part, removed by default and
// shown apart from the verified trackers. A protected short name (v t s q ...) is an
// Unrecognised part too, but unticked (canonical review finding C5). These tests cover:
//   1. Marcos's exact link, img_index kept, a profile link left alone;
//   2. every canonical rule with at least two links it cleans and one it must not touch;
//   3. unticking an Unrecognised part keeps it byte for byte;
//   4. links left untouched (signed, sign-in, Proofpoint) stay untouched;
//   5. the rule build refusing malformed canonical rules;
//   6. wording, and the invariants over every analysis made here.
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
const REVEALS = 'Not on the verified lists for this kind of page. This page opens without it.';
const REVEALS_ASK = 'Not on the verified lists for this kind of page. Short names like this one often choose what a page shows.';

const seen = [];
function A(input) {
  const r = analyse(input);
  seen.push(r);
  for (const h of r.hidden) if (h.analysis) seen.push(h.analysis);
  return r;
}
const part = (r, name) => r.parts.find((p) => p.name === name);
const unrecognised = (r) => r.parts.filter((p) => p.unrecognised);
const without = (r, ...names) => r.defaultRemoved.filter((id) => !names.some((n) => part(r, n) && part(r, n).id === id));

// == 1. Marcos's link ==

describe('canonical pages: the Instagram link Marcos tested', () => {
  const MARCOS = 'https://www.instagram.com/p/DeTqc0NDifd/?utm_source=ig_web_copy_link&mdxt=NTc4MTIwNjQ2YQ==';

  test('his exact link comes back as the bare post address', () => {
    const r = A(MARCOS);
    assert.equal(r.cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/');
    assert.equal(r.changed, true);
    assert.equal(r.host, 'www.instagram.com');
  });

  // Spec decision 17 (10 October 2026): mdxt (and exln) carried the same value on two shares
  // by one account, so they are now verified rules that identify the sharer. The canonical
  // rule still catches any other unknown name, shown here as unknownid.
  test('mdxt is now a verified sharer ID: removed by default, the same for everyone who got the link', () => {
    const r = A(MARCOS);
    const m = part(r, 'mdxt');
    assert.deepEqual(
      { where: m.where, value: m.value, provider: m.provider, reveals: m.reveals, defaultRemove: m.defaultRemove, ask: m.ask, unique: m.unique, family: m.family, unrecognised: m.unrecognised, affiliate: m.affiliate, sharer: m.sharer },
      { where: 'query', value: 'NTc4MTIwNjQ2YQ==', provider: 'Instagram sharer ID', reveals: 'The same value comes with every link this account shares, so it can link the shares back to you.', defaultRemove: true, ask: false, unique: false, family: 'Meta', unrecognised: false, affiliate: null, sharer: true },
    );
    assert.ok(!m.rule.startsWith('canonical:'));
    assert.ok(r.defaultRemoved.includes(m.id));
    assert.ok(r.segments.some((s) => s.partId === m.id && s.removed && s.text.includes('mdxt=NTc4MTIwNjQ2YQ==')), 'red and struck through in the full link');
  });

  test('an unknown parameter is an Unrecognised part: labelled apart, removed by default, unique from its value', () => {
    const r = A('https://www.instagram.com/p/DeTqc0NDifd/?utm_source=ig_web_copy_link&unknownid=NTc4MTIwNjQ2YQ==');
    const m = part(r, 'unknownid');
    assert.deepEqual(
      { where: m.where, value: m.value, provider: m.provider, reveals: m.reveals, defaultRemove: m.defaultRemove, ask: m.ask, unique: m.unique, family: m.family, rule: m.rule, unrecognised: m.unrecognised, affiliate: m.affiliate },
      { where: 'query', value: 'NTc4MTIwNjQ2YQ==', provider: 'Instagram', reveals: REVEALS, defaultRemove: true, ask: false, unique: true, family: 'Meta', rule: 'canonical:instagram-post', unrecognised: true, affiliate: null },
    );
    assert.ok(r.defaultRemoved.includes(m.id));
    assert.equal(r.cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/');
  });

  test('the verified tracker keeps its own label', () => {
    const r = A(MARCOS);
    const u = part(r, 'utm_source');
    const elsewhere = part(A('https://example.com/?utm_source=ig_web_copy_link'), 'utm_source');
    assert.equal(u.unrecognised, false);
    assert.equal(u.provider, elsewhere.provider);
    assert.equal(u.reveals, elsewhere.reveals);
    assert.ok(!u.rule.startsWith('canonical:'));
  });

  test('every other part carries unrecognised: false', () => {
    const r = A('https://www.amazon.co.uk/Some-Product/dp/B08N5WRWNW/ref=sr_1_3?tag=affil-21&mystery=1');
    assert.deepEqual(r.parts.map((p) => [p.name.startsWith('/ref=') ? 'ref-path' : p.name, p.unrecognised]), [['ref-path', false], ['tag', false], ['mystery', true]]);
    const w = A('https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Fp%2FDeTqc0NDifd%2F%3Fmdxt%3Dabc123&e=AT0');
    assert.equal(w.parts[0].where, 'wrapper');
    assert.equal(w.parts[0].unrecognised, false);
  });

  test('img_index (the carousel slide) stays, listed under "Kept on purpose"', () => {
    const r = A('https://www.instagram.com/p/DeTqc0NDifd/?img_index=3&utm_source=ig_web_copy_link&mdxt=NTc4MTIwNjQ2YQ==');
    assert.equal(r.cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/?img_index=3');
    const k = r.kept.find((x) => x.name === 'img_index');
    assert.equal(k.reason, 'functional');
    assert.match(k.note, /slide of a carousel/);
    assert.equal(part(r, 'img_index'), undefined);
  });

  test('an Instagram profile link with an unknown parameter is not touched; the verified sharer ID still goes', () => {
    const s = 'https://www.instagram.com/stormberry.as/?hl=en&unknownid=NTc4MTIwNjQ2YQ==';
    const r = A(s);
    assert.equal(r.cleanLink, s);
    assert.equal(r.parts.length, 0);
    assert.equal(r.changed, false);
    assert.equal(A('https://www.instagram.com/stormberry.as/?hl=en&mdxt=NTc4MTIwNjQ2YQ==').cleanLink, 'https://www.instagram.com/stormberry.as/?hl=en');
  });

  test('the same post through the l.instagram.com shim: the shim goes and mdxt goes', () => {
    const r = A('https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Fp%2FDeTqc0NDifd%2F%3Fmdxt%3DNTc4MTIwNjQ2YQ%253D%253D&e=AT0abc');
    assert.deepEqual(r.wrappers.map((w) => w.id), ['instagram-l']);
    assert.equal(r.cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/');
    assert.equal(part(r, 'mdxt').sharer, true);
  });
});

// == 2. every rule: two links it cleans, one it must not touch ==

// [rule id, link, expected clean link]. A positive case must also have at least one
// Unrecognised part from that rule; a negative case must have none.
const POSITIVE = [
  ['instagram-post', 'https://www.instagram.com/p/DeTqc0NDifd/?utm_source=ig_web_copy_link&unknownid=NTc4MTIwNjQ2YQ==', 'https://www.instagram.com/p/DeTqc0NDifd/'],
  ['instagram-post', 'https://instagram.com/reel/C9xYz12AbCd/?igsh=MTc4ZmVhNmQ0&unknownid=abc', 'https://instagram.com/reel/C9xYz12AbCd/'],
  ['instagram-post', 'https://m.instagram.com/tv/C9xYz12AbCd?mystery=1', 'https://m.instagram.com/tv/C9xYz12AbCd'],
  ['instagram-post', 'https://www.instagram.com/stormberry.as/p/DeTqc0NDifd/?unknownid=NTc4', 'https://www.instagram.com/stormberry.as/p/DeTqc0NDifd/'],
  ['instagram-post', 'https://www.instagram.com/reels/C9xYz12AbCd/?mystery=1&utm_medium=copy_link', 'https://www.instagram.com/reels/C9xYz12AbCd/'],
  ['instagram-post', 'www.instagram.com/p/DeTqc0NDifd/?unknownid=x1', 'www.instagram.com/p/DeTqc0NDifd/'],
  ['instagram-post', 'https://www.instagram.com/p/DeTqc0NDifd/?unknownid=a1#img=2&foo', 'https://www.instagram.com/p/DeTqc0NDifd/'],
  ['threads-post', 'https://www.threads.net/@stormberry.as/post/C9xYz12AbCd?xmt=AQGzAbC&slof=1', 'https://www.threads.net/@stormberry.as/post/C9xYz12AbCd'],
  ['threads-post', 'https://www.threads.com/@stormberry.as/post/C9xYz12AbCd/?mystery=2&xmt=AQGz', 'https://www.threads.com/@stormberry.as/post/C9xYz12AbCd/'],
  ['x-status', 'https://x.com/stormberry/status/1844000000000000000?s=46&t=AbCdEfGh&mx=2', 'https://x.com/stormberry/status/1844000000000000000'],
  ['x-status', 'https://twitter.com/stormberry/status/1844000000000000000/photo/1?ref_src=twsrc%5Etfw&mystery=1', 'https://twitter.com/stormberry/status/1844000000000000000/photo/1'],
  ['x-status', 'https://mobile.x.com/i/web/status/1844000000000000000?mystery=1', 'https://mobile.x.com/i/web/status/1844000000000000000'],
  ['tiktok-video', 'https://www.tiktok.com/@stormberry/video/7420000000000000000?is_from_webapp=1&sender_device=pc&lang=en&mystery=1', 'https://www.tiktok.com/@stormberry/video/7420000000000000000?lang=en'],
  ['tiktok-video', 'https://m.tiktok.com/@stormberry/photo/7420000000000000000?_r=1&_t=8abcDEF&mystery=1', 'https://m.tiktok.com/@stormberry/photo/7420000000000000000'],
  ['youtube-shorts', 'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share&mystery=1', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
  ['youtube-shorts', 'https://m.youtube.com/shorts/dQw4w9WgXcQ?si=AbCdEf12&t=5&mystery=2', 'https://m.youtube.com/shorts/dQw4w9WgXcQ?t=5'],
  ['spotify-item', 'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?si=8dyy8ff75d4a4fa8&mystery=1', 'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0'],
  ['spotify-item', 'https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy?si=abc&nd=1&mystery=2', 'https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy?nd=1'],
  ['spotify-item', 'https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?si=def&t=120&mystery=3', 'https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?t=120'],
  ['amazon-product', 'https://www.amazon.co.uk/dp/B08N5WRWNW?language=en_GB&psc=1&smid=A3JWKAKR8XB7XF&mystery=1', 'https://www.amazon.co.uk/dp/B08N5WRWNW?language=en_GB&psc=1&smid=A3JWKAKR8XB7XF'],
  ['amazon-product', 'https://www.amazon.com/Echo-Dot/dp/B07XJ8C8F5/ref=sr_1_3?crid=2XYZ&mystery=1', 'https://www.amazon.com/Echo-Dot/dp/B07XJ8C8F5'],
  ['amazon-product', 'https://amazon.de/gp/product/B07XJ8C8F5?mystery=1&th=1', 'https://amazon.de/gp/product/B07XJ8C8F5'],
  ['amazon-product', 'https://www.amazon.de/-/en/dp/B07XJ8C8F5?mystery=1', 'https://www.amazon.de/-/en/dp/B07XJ8C8F5'],
];

// [rule id, link, expected clean link]: the same sites, but a path or host the rule does
// not cover. Their unknown parameters stay.
const NEGATIVE = [
  ['instagram-post', 'https://www.instagram.com/stormberry.as/?hl=en&unknownid=NTc4MTIwNjQ2YQ==', 'https://www.instagram.com/stormberry.as/?hl=en&unknownid=NTc4MTIwNjQ2YQ=='],
  ['instagram-post', 'https://www.instagram.com/stories/stormberry.as/3400000000000000000/?unknownid=x1', 'https://www.instagram.com/stories/stormberry.as/3400000000000000000/?unknownid=x1'],
  ['instagram-post', 'https://www.instagram.com/explore/tags/bergen/?unknownid=x1', 'https://www.instagram.com/explore/tags/bergen/?unknownid=x1'],
  ['instagram-post', 'https://www.instagram.com/p/DeTqc0NDifd/liked_by/?unknownid=x1', 'https://www.instagram.com/p/DeTqc0NDifd/liked_by/?unknownid=x1'],
  ['instagram-post', 'https://about.instagram.com/p/DeTqc0NDifd/?unknownid=x1', 'https://about.instagram.com/p/DeTqc0NDifd/?unknownid=x1'],
  ['instagram-post', 'https://www.instagram.com.evil.io/p/DeTqc0NDifd/?unknownid=x1', 'https://www.instagram.com.evil.io/p/DeTqc0NDifd/?unknownid=x1'],
  ['instagram-post', 'https://notinstagram.com/p/DeTqc0NDifd/?unknownid=x1', 'https://notinstagram.com/p/DeTqc0NDifd/?unknownid=x1'],
  ['threads-post', 'https://www.threads.net/@stormberry.as?mystery=1', 'https://www.threads.net/@stormberry.as?mystery=1'],
  ['threads-post', 'https://www.threads.com/@stormberry.as/post/C9xYz12AbCd/media?mystery=1', 'https://www.threads.com/@stormberry.as/post/C9xYz12AbCd/media?mystery=1'],
  ['x-status', 'https://x.com/search?q=fjord&f=live&mystery=1', 'https://x.com/search?q=fjord&f=live&mystery=1'],
  ['x-status', 'https://x.com/stormberry?mystery=1', 'https://x.com/stormberry?mystery=1'],
  ['x-status', 'https://x.com.evil.io/stormberry/status/1844000000000000000?mystery=1', 'https://x.com.evil.io/stormberry/status/1844000000000000000?mystery=1'],
  ['tiktok-video', 'https://www.tiktok.com/search?q=fjord&mystery=1', 'https://www.tiktok.com/search?q=fjord&mystery=1'],
  ['tiktok-video', 'https://www.tiktok.com/@stormberry?mystery=1', 'https://www.tiktok.com/@stormberry?mystery=1'],
  ['youtube-shorts', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&mystery=1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&mystery=1'],
  ['youtube-shorts', 'https://www.youtube.com/shorts/short?mystery=1', 'https://www.youtube.com/shorts/short?mystery=1'],
  ['youtube-shorts', 'https://youtu.be/dQw4w9WgXcQ?mystery=1', 'https://youtu.be/dQw4w9WgXcQ?mystery=1'],
  ['spotify-item', 'https://open.spotify.com/search/fjord?mystery=1', 'https://open.spotify.com/search/fjord?mystery=1'],
  ['spotify-item', 'https://open.spotify.com/user/stormberry?mystery=1', 'https://open.spotify.com/user/stormberry?mystery=1'],
  ['spotify-item', 'https://spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?mystery=1', 'https://spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?mystery=1'],
  ['amazon-product', 'https://www.amazon.com/s?k=lego&mystery=1', 'https://www.amazon.com/s?k=lego&mystery=1'],
  ['amazon-product', 'https://smile.amazon.com/dp/B07XJ8C8F5?mystery=1', 'https://smile.amazon.com/dp/B07XJ8C8F5?mystery=1'],
  ['amazon-product', 'https://www.amazon.co.com/dp/B07XJ8C8F5?mystery=1', 'https://www.amazon.co.com/dp/B07XJ8C8F5?mystery=1'],
  ['amazon-product', 'https://www.amazon.com/dp/B0ABC?mystery=1', 'https://www.amazon.com/dp/B0ABC?mystery=1'],
];

describe('canonical pages: every rule cleans its own pages and nothing else', () => {
  // The search engines and LinkedIn posts (batch 3, 10 October 2026) follow these seven and
  // have their own cases in tests/search-engines.test.mjs.
  test('the seven original canonical rules come first, and each has at least two positive and one negative case here', () => {
    const ORIGINAL = ['instagram-post', 'threads-post', 'x-status', 'tiktok-video', 'youtube-shorts', 'spotify-item', 'amazon-product'];
    assert.deepEqual(RULES.canonical.slice(0, 7).map((c) => c.id), ORIGINAL);
    for (const c of RULES.canonical.slice(0, 7)) {
      assert.ok(POSITIVE.filter((x) => x[0] === c.id).length >= 2, `${c.id}: two positive cases`);
      assert.ok(NEGATIVE.filter((x) => x[0] === c.id).length >= 1, `${c.id}: one negative case`);
    }
  });

  for (const [id, link, want] of POSITIVE) {
    test(`${id} cleans ${link.slice(0, 80)}`, () => {
      const r = A(link);
      assert.equal(r.cleanLink, want);
      const mine = unrecognised(r);
      assert.ok(mine.length > 0, 'at least one Unrecognised part');
      for (const p of mine) {
        assert.equal(p.rule, `canonical:${id}`);
        assert.equal(p.reveals, REVEALS);
        assert.equal(p.defaultRemove, true);
        assert.equal(p.ask, false);
        assert.equal(p.provider, RULES.canonical.find((c) => c.id === id).platform, 'the provider line is the platform alone');
      }
      assert.ok(r.parts.filter((p) => !p.unrecognised).every((p) => !p.rule.startsWith('canonical:')), 'verified parts keep their own rule');
    });
  }

  for (const [id, link, want] of NEGATIVE) {
    test(`${id} leaves ${link.slice(0, 80)}`, () => {
      const r = A(link);
      assert.equal(r.cleanLink, want);
      assert.equal(unrecognised(r).length, 0);
    });
  }

  test('a functional_keep entry still keeps what it names (Spotify t, TikTok lang, YouTube t), shown under "Kept on purpose"', () => {
    for (const [link, name] of [
      ['https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?si=def&t=120&mystery=3', 't'],
      ['https://www.tiktok.com/@stormberry/video/7420000000000000000?lang=en&mystery=1', 'lang'],
      ['https://m.youtube.com/shorts/dQw4w9WgXcQ?t=5&mystery=2', 't'],
    ]) {
      const r = A(link);
      assert.equal(part(r, name), undefined, `${link}: ${name} is not a part`);
      assert.ok(r.kept.some((k) => k.name === name && k.reason === 'functional' && k.note), `${link}: ${name} kept with a note`);
    }
  });

  test('Amazon psc and smid stay through their verified rules, language through the keep list (finding C1)', () => {
    const r = A('https://www.amazon.co.uk/dp/B08N5WRWNW?language=en_GB&psc=1&smid=A3JWKAKR8XB7XF&mystery=1');
    assert.deepEqual(r.kept.map((k) => k.name), ['language', 'psc', 'smid']);
    // aod and m joined in batch 3 (canonical review finding C4).
    assert.deepEqual(RULES.canonical.find((c) => c.id === 'amazon-product').keep.map((k) => k.name), ['psc', 'smid', 'language', 'aod', 'm']);
    assert.equal(part(r, 'language'), undefined, 'language is not a part');
    assert.equal(r.kept[0].note, 'Amazon: language chooses the language the page is shown in.');
    assert.equal(part(r, 'mystery').unrecognised, true);
    assert.equal(r.cleanLink, 'https://www.amazon.co.uk/dp/B08N5WRWNW?language=en_GB&psc=1&smid=A3JWKAKR8XB7XF');
  });

  test('a protected short name on a canonical page is an Unrecognised "ask" part: shown, unticked, removed only when ticked (finding C5)', () => {
    // (TikTok t on a video was the first case here; spec decision 23 of 10 October 2026 has
    // it removed by default under its own label, tested below. TikTok s takes its place.)
    for (const [link, name, bare] of [
      ['https://www.tiktok.com/@stormberry/video/7420000000000000000?s=2&mystery=1', 's', 'https://www.tiktok.com/@stormberry/video/7420000000000000000?s=2'],
      ['https://www.instagram.com/p/DeTqc0NDifd/?p=2&mdxt=NTc4MTIwNjQ2YQ==', 'p', 'https://www.instagram.com/p/DeTqc0NDifd/?p=2'],
      ['https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?si=abc&V=3', 'V', 'https://open.spotify.com/track/0PsBajvo0g7bLLHxwH3Sk0?V=3'],
    ]) {
      const r = A(link);
      const p = part(r, name);
      assert.deepEqual(
        { unrecognised: p.unrecognised, defaultRemove: p.defaultRemove, ask: p.ask, reveals: p.reveals, rule: p.rule.startsWith('canonical:') },
        { unrecognised: true, defaultRemove: false, ask: true, reveals: REVEALS_ASK, rule: true },
        link,
      );
      assert.ok(!r.defaultRemoved.includes(p.id), link);
      assert.equal(r.cleanLink, bare, 'kept by default, byte for byte');
      assert.equal(r.clean([...r.defaultRemoved, p.id]), bare.replace(/\?.*$/, ''), 'one tick removes it');
    }
  });

  test('TikTok t on a video or photo goes, ticked, under its own label, not as Unrecognised (spec decision 23)', () => {
    for (const base of ['https://www.tiktok.com/@stormberry/video/7420000000000000000', 'https://m.tiktok.com/@stormberry/photo/7420000000000000000']) {
      const r = A(`${base}?t=1700000000&mystery=1`);
      const t = part(r, 't');
      assert.deepEqual(
        { provider: t.provider, unrecognised: t.unrecognised, defaultRemove: t.defaultRemove, ask: t.ask, rule: t.rule },
        { provider: 'TikTok timestamp', unrecognised: false, defaultRemove: true, ask: false, rule: 'verified-page:tiktok-video' },
        base,
      );
      assert.equal(r.cleanLink, base);
      assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== t.id)), `${base}?t=1700000000`, 'unticked, it stays byte for byte');
    }
    // On /search t is still the verified search timestamp, and q stays.
    const s = A('https://www.tiktok.com/search?q=fjord&t=1700000000000');
    assert.equal(part(s, 't').provider, 'TikTok search timestamp');
    assert.equal(s.cleanLink, 'https://www.tiktok.com/search?q=fjord');
  });

  test('language choices stay on the pages that take them, listed under "Kept on purpose" (finding C1)', () => {
    for (const [link, name] of [
      ['https://www.instagram.com/p/DeTqc0NDifd/?hl=pt-br&mdxt=NTc4MTIwNjQ2YQ==', 'hl'],
      ['https://www.threads.com/@stormberry.as/post/C9xYz12AbCd?hl=nb&xmt=AQGz', 'hl'],
      ['https://www.youtube.com/shorts/dQw4w9WgXcQ?hl=pt&si=AbCdEf12', 'hl'],
      ['https://x.com/stormberry/status/1844000000000000000?lang=nb&s=20', 'lang'],
    ]) {
      const r = A(link);
      const k = r.kept.find((x) => x.name === name);
      assert.ok(k && k.reason === 'functional' && / chooses the language the page is shown in\.$/.test(k.note), link);
      assert.equal(part(r, name), undefined, link);
      assert.ok(r.cleanLink.includes(`?${name}=`), r.cleanLink);
    }
  });

  test('the Spotify collaborator invite (pt) stays with its note; the share IDs around it go (finding C3)', () => {
    const r = A('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc&pt=def123&pi=ghi');
    assert.equal(r.cleanLink, 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?pt=def123');
    assert.match(r.kept.find((k) => k.name === 'pt').note, /^Spotify: pt is the invitation to join a playlist as a collaborator;/);
  });

  test('a text highlight after an anchor is never a list of pairs, but a sign-in value before it still leaves the link untouched (finding C2)', () => {
    assert.equal(A('https://www.amazon.com/dp/B07XJ8C8F5?mystery=1#customerReviews:~:text=battery').cleanLink, 'https://www.amazon.com/dp/B07XJ8C8F5#customerReviews:~:text=battery');
    assert.equal(A('https://example.com/page?utm_source=x#top:~:text=a=b').cleanLink, 'https://example.com/page#top:~:text=a=b');
    const s = 'https://www.instagram.com/p/DeTqc0NDifd/?mdxt=1#access_token=abc:~:text=hello';
    const r = A(s);
    assert.equal(r.untouched && r.untouched.id, 'auth');
    assert.equal(r.cleanLink, s);
  });

  test('a base64 value that spells words is not unique to the click; one that spells an identifier is (finding C9)', () => {
    assert.equal(part(A('https://www.amazon.com/dp/B07XJ8C8F5?almBrandId=QW1hem9uIEZyZXNo'), 'almBrandId').unique, false);
    assert.equal(part(A('https://www.amazon.com/dp/B07XJ8C8F5?mystery=Tm9yZGljIEZqb3Jk'), 'mystery').unique, false, 'Nordic Fjord');
    assert.equal(part(A('https://www.instagram.com/p/DeTqc0NDifd/?unknownid=NTc4MTIwNjQ2YQ%3D%3D'), 'unknownid').unique, true, '578120646a');
  });

  test('an "ask" rule on a canonical page stays an "ask" part, not Unrecognised', () => {
    const r = A('https://www.amazon.com/dp/B07XJ8C8F5?refinements=p_89%3ALEGO&mystery=1');
    const ask = part(r, 'refinements');
    assert.equal(ask.ask, true);
    assert.equal(ask.unrecognised, false);
    assert.equal(r.cleanLink, 'https://www.amazon.com/dp/B07XJ8C8F5?refinements=p_89%3ALEGO');
  });

  test('a value that looks generated is unique to the click; a short plain one is not', () => {
    assert.equal(part(A('https://www.instagram.com/p/DeTqc0NDifd/?unknownid=NTc4MTIwNjQ2YQ=='), 'unknownid').unique, true);
    assert.equal(part(A('https://www.instagram.com/p/DeTqc0NDifd/?mystery=1'), 'mystery').unique, false);
    const bare = part(A('https://www.instagram.com/p/DeTqc0NDifd/?flag'), 'flag');
    assert.deepEqual([bare.value, bare.unique, bare.defaultRemove], ['', false, true]);
  });

  test('a parameter name in capitals is still matched by the verified rules first (UTM_SOURCE, MDXT)', () => {
    const r = A('https://www.instagram.com/p/DeTqc0NDifd/?UTM_SOURCE=QR&MDXT=1&UNKNOWNID=1');
    assert.equal(part(r, 'UTM_SOURCE').unrecognised, false);
    assert.equal(part(r, 'MDXT').unrecognised, false, 'the verified sharer rule, in small letters');
    assert.equal(part(r, 'UNKNOWNID').unrecognised, true);
    assert.equal(r.cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/');
  });
});

// == 3. unticking ==

describe('canonical pages: an Unrecognised part is a choice like any other', () => {
  test('unticking mdxt keeps it byte for byte', () => {
    const r = A('https://www.instagram.com/p/DeTqc0NDifd/?utm_source=ig_web_copy_link&mdxt=NTc4MTIwNjQ2YQ==');
    assert.equal(r.clean(without(r, 'mdxt')), 'https://www.instagram.com/p/DeTqc0NDifd/?mdxt=NTc4MTIwNjQ2YQ==');
    assert.equal(r.clean([]), r.link, 'nothing removed gives the link as written');
    assert.ok(r.segmentsFor(without(r, 'mdxt')).some((s) => s.partId === part(r, 'mdxt').id && !s.removed), 'still marked as a part when kept');
  });

  test('percent escapes, + and their case survive unticking', () => {
    const r = A('https://www.instagram.com/p/DeTqc0NDifd/?mdxt=NTc4MTIwNjQ2YQ%3d%3D&utm_source=x&note=a+b%20c');
    assert.equal(r.cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/');
    assert.equal(r.clean(without(r, 'mdxt', 'note')), 'https://www.instagram.com/p/DeTqc0NDifd/?mdxt=NTc4MTIwNjQ2YQ%3d%3D&note=a+b%20c');
    assert.equal(r.clean(without(r, 'note')), 'https://www.instagram.com/p/DeTqc0NDifd/?note=a+b%20c');
  });

  test('a kept plain fragment stays when the query goes', () => {
    assert.equal(A('https://x.com/stormberry/status/1844000000000000000?mystery=1#reply').cleanLink, 'https://x.com/stormberry/status/1844000000000000000#reply');
  });

  test('the Amazon /ref= path part, unticked, does not change what the canonical rule decided', () => {
    const r = A('https://www.amazon.com/Echo-Dot/dp/B07XJ8C8F5/ref=sr_1_3?mystery=1');
    const ref = r.parts.find((p) => p.where === 'path');
    assert.equal(r.clean(r.defaultRemoved.filter((id) => id !== ref.id)), 'https://www.amazon.com/Echo-Dot/dp/B07XJ8C8F5/ref=sr_1_3');
  });
});

// == 4. links left untouched ==

describe('canonical pages: never on a link left untouched', () => {
  for (const [label, s, id] of [
    ['a sign-in value on an Instagram post', 'https://www.instagram.com/p/DeTqc0NDifd/?token=abc123&mdxt=NTc4MTIwNjQ2YQ==', 'auth'],
    ['a signed Amazon product link', 'https://www.amazon.com/dp/B07XJ8C8F5?X-Amz-Signature=abc&mystery=1', 'signed'],
    ['Proofpoint around an Instagram post', 'https://urldefense.com/v3/__https://www.instagram.com/p/DeTqc0NDifd/?mdxt=NTc4__;!!abc$', 'urldefense'],
    ['an OAuth return on an X status path', 'https://x.com/stormberry/status/1844000000000000000?code=4%2F0Ab&state=xyz&mystery=1', 'auth'],
  ]) {
    test(`${label} stays byte for byte`, () => {
      const r = A(s);
      assert.equal(r.untouched.id, id);
      assert.equal(r.cleanLink, s);
      assert.equal(r.parts.length, 0);
    });
  }
});

// == 5. the rule build ==

describe('canonical pages: the rule build', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'checklink-canonical-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const extra = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'extra-rules.json'), 'utf8'));
  const build = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-rules.mjs'), ...args], { encoding: 'utf8' });

  test('the canonical rules in src/rules.js are the ones in extra-rules.json, each with an anchored host pattern', () => {
    assert.deepEqual(RULES.canonical.map((c) => c.id), extra.canonical.rules.map((c) => c.id));
    for (const c of RULES.canonical) {
      assert.ok(c.host.startsWith('^(?:') && c.host.endsWith(')$'), c.host);
      for (const p of c.paths) assert.ok(p.startsWith('^/') && p.endsWith('$'), p);
      assert.equal(c.reveals, REVEALS);
      assert.equal(c.askReveals, REVEALS_ASK);
      assert.equal(c.provider, c.platform);
    }
    // Structural for the original seven and LinkedIn posts; Verified, with its sources, for
    // the search engines (batch 3). The basis is carried into src/rules.js.
    for (const c of extra.canonical.rules) assert.ok(typeof c.basis === 'string' && /^(?:Structural|Verified):/.test(c.basis), `${c.id} cites a structural or verified basis`);
    for (const c of RULES.canonical) assert.equal(c.basis, extra.canonical.rules.find((x) => x.id === c.id).basis);
  });

  const refuse = (label, change, message) => {
    test(`refuses ${label}`, () => {
      const bad = structuredClone(extra);
      change(bad.canonical.rules[0], bad);
      const slug = label.replace(/\W+/g, '-');
      const file = path.join(tmp, `${slug}.json`);
      const out = path.join(tmp, `${slug}.js`);
      writeFileSync(file, JSON.stringify(bad));
      const res = build('--extra', file, '--out', out);
      assert.equal(res.status, 1, res.stdout);
      assert.match(res.stderr, message);
      assert.match(res.stderr, /refused/);
      assert.equal(existsSync(out), false, 'nothing is written');
    });
  };
  refuse('a host written as a wildcard subdomain', (c) => { c.hosts.push('*.instagram.com'); }, /host "\*\.instagram\.com" must be one exact name/);
  // A bare * is accepted since batch 3, but only with requires clauses (SearXNG runs on any host).
  refuse('a bare * host without requires clauses', (c) => { c.hosts = ['*']; }, /host "\*" needs requires clauses/);
  refuse('a host with capitals', (c) => { c.hosts.push('WWW.Instagram.com'); }, /must be one exact name/);
  refuse('a host that is a single label', (c) => { c.hosts.push('com'); }, /host "com" must be one exact name/);
  refuse('a path not anchored at the start', (c) => { c.paths = ['/p/[A-Za-z0-9_-]+/?$']; }, /must be anchored at both ends/);
  refuse('a path not anchored at the end', (c) => { c.paths = ['^/p/[A-Za-z0-9_-]+/?']; }, /must be anchored at both ends/);
  refuse('a path that matches the home page', (c) => { c.paths = ['^/.*$']; }, /matches the home page/);
  refuse('a path JavaScript cannot compile', (c) => { c.paths = ['^/(?P<code>p)/$']; }, /JavaScript cannot compile/);
  refuse('a keep name that a host rule removes on the same hosts', (c) => { c.keep.push({ name: 'igsh', note: 'Test.' }); }, /keep names "igsh", which the rule "igsh" \(strip\) removes on these hosts/);
  refuse('a keep name that a global rule removes', (c) => { c.keep.push({ name: 'utm_source', note: 'Test.' }); }, /keep names "utm_source", which the rule "utm_\*?\w*" \(strip\) removes/);
  refuse('a keep entry without a note', (c) => { c.keep = [{ name: 'img_index' }]; }, /each keep entry needs a name and a note/);
  refuse('a keep list that is missing', (c) => { delete c.keep; }, /keep must be a list/);
  refuse('a rule without a basis', (c) => { delete c.basis; }, /basis is required/);
  refuse('an unknown key', (c) => { c.default = 'strip'; }, /unknown key "default"/);
  refuse('two rules with the same id', (c, all) => { all.canonical.rules.push(structuredClone(c)); }, /duplicate id/);
  refuse('a canonical section without the text for unticked short names', (c, all) => { delete all.canonical.reveals_ask; }, /reveals, reveals_ask and rules are required/);

  test('the build says that protected names are shown unticked on canonical pages, and names each one a keep list keeps', () => {
    const res = build('--check');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /canonical rules: a protected name \(v t s q .*\) that a rule's keep list does not name is shown unticked on its pages, never removed by default/);
    for (const [id, name] of [['instagram-post', 'hl'], ['threads-post', 'hl'], ['x-status', 'lang'], ['youtube-shorts', 'hl']]) {
      assert.match(res.stdout, new RegExp(`canonical rule "${id}" keeps protected "${name}": accepted`));
    }
  });
});

// == 6. wording and invariants ==

describe('canonical pages: wording and invariants', () => {
  test('notes under "Kept on purpose" are written for the reader: no list, reviewer or issue number (findings C6 and C7)', () => {
    const notes = [
      ...RULES.functionalKeep.filter((f) => f.effect === 'never_strip').map((f) => f.note),
      ...RULES.canonical.flatMap((c) => c.keep.map((k) => k.note)),
    ];
    assert.ok(notes.length >= 35, `${notes.length} notes`);
    for (const n of notes) {
      // "Brave Search" is the name of a search engine with its own canonical rule, not a list.
      assert.doesNotMatch(n, /\b(LUS|ClearURLs|DandelionSprout|Tidy URL|uBO|uBlock|AdGuard|Brave(?! Search)|Firefox|Unfurl|Neat URL|allow-list|verbatim|issue \d+|verified on|consulted|Do not copy|must stay|keep_paths)\b/i, n);
      assert.ok(n.length <= 260, `short enough to read in a row: ${n}`);
    }
  });

  test('nothing a canonical rule can show uses an em dash, "safe", an exclamation mark, alarm words or American spelling', () => {
    const texts = [];
    for (const c of RULES.canonical) {
      texts.push(c.provider, c.reveals, c.askReveals, c.family, c.platform);
      for (const k of c.keep) texts.push(k.note);
    }
    for (const r of seen) {
      for (const p of r.parts.filter((x) => x.unrecognised)) texts.push(p.provider, p.reveals);
      for (const k of r.kept) texts.push(k.note || '');
    }
    assert.ok(texts.length > 50);
    for (const t of texts) {
      assert.ok(!/—|–|--/.test(t), `no em dash, en dash or double hyphen: ${t}`);
      assert.ok(!/\bsafe/i.test(t), `never "safe": ${t}`);
      assert.ok(!t.includes('!'), `no exclamation mark: ${t}`);
      assert.ok(!/\b(scam\w*|fake|malicious|danger\w*)\b/i.test(t), `calm wording: ${t}`);
      assert.ok(!/\b(color\w*|organiz\w*|gray|center(ed|s)?|favorite\w*|behavior\w*|analyz\w*|customiz\w*|recogniz\w*|unrecogniz\w*)\b/i.test(t), `British spelling: ${t}`);
    }
  });

  test('segments cover the link and clean() equals the kept segments for every choice', () => {
    let checked = 0;
    for (const r of seen) {
      if (!r.found) continue;
      const targetIds = r.parts.filter((p) => p.where !== 'wrapper').map((p) => p.id);
      const choices = [undefined, [], r.parts.map((p) => p.id), ...r.parts.map((p) => r.defaultRemoved.filter((id) => id !== p.id))];
      if (targetIds.length <= 6) for (let mask = 0; mask < 1 << targetIds.length; mask++) choices.push(targetIds.filter((_, i) => mask & (1 << i)));
      for (const ids of choices) {
        const segs = r.target.segmentsFor(ids);
        assert.equal(segs.map((s) => s.text).join(''), r.target.link, r.link);
        assert.equal(r.segmentsFor(ids).map((s) => s.text).join(''), r.link, r.link);
        const cut = segs.filter((s) => !s.removed).map((s) => s.text).join('');
        assert.equal(r.clean(ids === undefined ? undefined : [...r.wrappers.map((w) => w.partId), ...ids]), cut, r.link);
        if (segs.some((s) => s.removed)) assert.ok(!/[?&#]$/.test(cut) && !/[?&]&|&#|\?#/.test(cut), `no stray separators in ${cut}`);
        checked++;
      }
      assert.equal(new URL(r.openUrl()).hostname, r.target.host, r.link);
    }
    assert.ok(checked > 300, `checked ${checked} choices`);
  });
});
