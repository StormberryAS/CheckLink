// "Place only" (spec decision 18, confirmed by Marcos on 10 October 2026): on a Google Maps
// place link whose data= carries context, a third copy option after the full place link
// and Pin only, https://maps.google.com/?cid=<N>. N is the unsigned decimal of the second
// half of the place's own feature ID (the !1s0x<hex>:0x<hex> in the block that also holds
// the blob's final !3d<lat>!4d<lng>). Marcos checked in his browser that
// https://maps.google.com/?cid=7942154548931413284 opens Kleppestø Senter, whose feature ID
// in his M7 link is 0x463cfceb4b000b89:0x6e38337ba04f4524.
//
// Node 24 built-ins only. The page side is in tests/ui-smoke.mjs and tests/e2e.mjs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyse } from '../src/link-core.js';

const A = (s) => analyse(s);
const REG = Object.fromEntries(JSON.parse(readFileSync(new URL('../rules/marcos-regression.json', import.meta.url), 'utf8')).cases.map((c) => [c.id, c]));
const M6 = REG['M6-google-maps-place'];
const M7 = REG['M7-google-maps-trail'];
const note = (r) => (r.warnings.find((w) => w.id === 'maps-context') || {}).text;
const CID_LINK = /^https:\/\/maps\.google\.com\/\?cid=[1-9]\d{0,19}$/;
const MAX_ID = (1n << 64n) - 1n;
// A place link with a category in front of the place's own block.
const mp = (blob) => `https://www.google.com/maps/place/X/@60.4,5.2,15z/data=${blob}`;

describe("Place only: Marcos's own links", () => {
  test('M7: the cid is the one Marcos checked in his browser (Kleppestø Senter)', () => {
    const r = A(M7.dirty);
    assert.deepEqual(r.maps.place, {
      featureId: '0x463cfceb4b000b89:0x6e38337ba04f4524',
      cid: '7942154548931413284',
      link: 'https://maps.google.com/?cid=7942154548931413284',
    });
  });

  test('M7 carries two places: the cid belongs to the one paired with the final coordinates, not to Kleppestø viewed earlier', () => {
    const r = A(M7.dirty);
    const earlier = BigInt('0x32570ae48bb050ad').toString();
    assert.notEqual(r.maps.place.cid, earlier);
    assert.ok(M7.dirty.includes(`!3m5!1s${r.maps.place.featureId}!8m2!3d60.4103774!4d5.2268809`), 'the feature ID and the final coordinates share one block');
    assert.equal(r.maps.pin.link, 'https://www.google.com/maps/@60.4103774,5.2268809,17z', 'Pin only comes from the same block');
  });

  test('M6: a second half above 2^63 is read unsigned, and BigInt keeps every digit past 2^53', () => {
    const r = A(M6.dirty);
    assert.deepEqual(r.maps.place, {
      featureId: '0x463cfcef6083f98b:0x98cdfe7dedd13b92',
      cid: '11010736480805010322',
      link: 'https://maps.google.com/?cid=11010736480805010322',
    });
    assert.ok(BigInt(r.maps.place.cid) > (1n << 63n), 'above 2^63, so a signed reading would be negative');
    assert.notEqual(String(Number.parseInt('98cdfe7dedd13b92', 16)), r.maps.place.cid, 'a Number would have lost the last digits');
  });

  test('the clean link stays the full place link; Place only is offered beside it, never instead', () => {
    for (const c of [M6, M7]) {
      const r = A(c.dirty);
      assert.equal(r.cleanLink, c.clean, c.id);
      assert.notEqual(r.cleanLink, r.maps.place.link, c.id);
      assert.ok(!r.parts.some((p) => /cid/.test(p.name)), `${c.id}: no new part to tick`);
    }
  });

  test('the note points to both links under the clean link, in neutral words', () => {
    assert.equal(note(A(M6.dirty)), "This map address also holds something Maps picked up on the way to this place: a category or search words ('Vacation rentals'). Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.");
    assert.equal(note(A(M7.dirty)), "This map address also holds something Maps picked up on the way to this place: a place viewed earlier ('Kleppestø'). Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.");
  });
});

describe('Place only: links with no feature ID', () => {
  test('a place link whose data= has context but no place block with a feature ID: no Maps links at all', () => {
    for (const link of [
      mp('!4m5!1m2!2m1!1sCafes!8m2!3d60.4!4d5.2'),
      mp('!4m8!1m2!2m1!1sCafes!3m4!1sChIJabcdef!8m2!3d60.4!4d5.2'),
      mp('!4m8!1m2!2m1!1sCafes!3m4!1s0x463cfceb4b000b89!8m2!3d60.4!4d5.2'),
    ]) {
      const r = A(link);
      assert.equal(r.maps, null, link);
      assert.equal(r.cleanLink, link, link);
    }
  });

  test('a place link with no data= at all, or a map that is not a place, offers nothing', () => {
    for (const link of ['https://www.google.com/maps/place/Bryggen/@60.3973,5.3245,17z', 'https://www.google.com/maps/@60.4,5.3,15z', 'https://www.google.com/maps/search/pizza/@60.4,5.3,15z/data=!3m1!4b1']) {
      assert.equal(A(link).maps, null, link);
    }
  });

  test('a second half that is zero, or longer than a 64-bit ID, gives no Place only; Pin only and the note stay', () => {
    for (const id of ['0x1:0x0', '0x1:0x0000', '0x1:0x1ffffffffffffffff', '0x1:0x10000000000000000']) {
      const r = A(mp(`!4m8!1m2!2m1!1sCafes!3m4!1s${id}!8m2!3d60.4!4d5.2`));
      assert.ok(r.maps, id);
      assert.equal(r.maps.place, null, id);
      assert.equal(r.maps.pin.link, 'https://www.google.com/maps/@60.4,5.2,17z', id);
      assert.ok(note(r).endsWith(' Pin only, under the clean link, leaves it out.'), id);
    }
  });
});

describe('Place only: links with several places', () => {
  test('three places in the blob: the last one, which holds the final coordinates, gives the cid', () => {
    const r = A(mp('!4m24!1m8!3m7!1s0x1:0xaaa!2sFirst!3b1!8m2!3d60.1!4d5.1!16sa!1m8!3m7!1s0x1:0xbbb!2sSecond!3b1!8m2!3d60.2!4d5.2!16sb!3m5!1s0x1:0xccc!8m2!3d60.3!4d5.3!16sc'));
    assert.deepEqual(r.maps.context, [{ kind: 'place', name: 'First' }, { kind: 'place', name: 'Second' }]);
    assert.deepEqual(r.maps.place, { featureId: '0x1:0xccc', cid: '3276', link: 'https://maps.google.com/?cid=3276' });
    assert.equal(r.maps.pin.link, 'https://www.google.com/maps/@60.3,5.3,17z');
  });

  test('when the final coordinates lie outside the last place block, no ID can be paired with them: no Place only', () => {
    // The last block has no coordinates; the final ones belong to the place before it.
    const earlierHasThem = A(mp('!4m11!1m2!2m1!1sCafes!3m4!1s0x1:0xaaa!8m2!3d60.1!4d5.1!3m2!1s0x1:0xbbb!16sb'));
    assert.ok(earlierHasThem.maps);
    assert.equal(earlierHasThem.maps.place, null);
    assert.equal(earlierHasThem.maps.pin, null);
    assert.ok(note(earlierHasThem).endsWith('so CheckLink leaves it in.'), 'no pointer to links that are not offered');
    // The last block has its own coordinates, but later ones follow outside it.
    const laterOnes = A(mp('!4m11!1m2!2m1!1sCafes!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2!8m2!3d61.5!4d6.5'));
    assert.equal(laterOnes.maps.place, null);
    assert.equal(laterOnes.maps.pin.link, 'https://www.google.com/maps/@60.4,5.2,17z', 'Pin only stays: it comes from the block itself');
    assert.ok(note(laterOnes).endsWith(' Pin only, under the clean link, leaves it out.'));
  });

  test('coordinates outside the map give no Pin only, but the paired ID still gives Place only', () => {
    const r = A(mp('!4m8!1m2!2m1!1sCafes!3m4!1s0x1:0x2!8m2!3d99.4!4d5.2'));
    assert.equal(r.maps.pin, null);
    assert.equal(r.maps.place.link, 'https://maps.google.com/?cid=2');
    assert.ok(note(r).endsWith(' Place only, under the clean link, leaves it out.'));
  });
});

describe('Place only: the number itself', () => {
  test('upper-case hex, leading zeros and the largest 64-bit ID read as plain decimals', () => {
    for (const [id, cid] of [['0x1:0xFF', '255'], ['0x1:0x000000000000000000002a', '42'], ['0x1:0xffffffffffffffff', MAX_ID.toString()], ['0x1:0x8000000000000000', (1n << 63n).toString()]]) {
      assert.equal(A(mp(`!4m8!1m2!2m1!1sCafes!3m4!1s${id}!8m2!3d60.4!4d5.2`)).maps.place.cid, cid, id);
    }
  });

  test('the link is built from digits alone, so nothing from the address can ride on it', () => {
    const odd = ['0x1:0x2', '0x1:0xffffffffffffffff', '0x1:0x2%3Fx', '0x1:0x2&evil=1', '0x1:0x2#frag', '0x1:0x2/../x', '0x1:0x2:0x3', '0x1:0x 2', '0x1:0x2%0A'];
    for (const id of odd) {
      const r = A(mp(`!4m8!1m2!2m1!1sCafes!3m4!1s${id}!8m2!3d60.4!4d5.2`));
      const place = r.maps && r.maps.place;
      if (!place) continue;
      assert.match(place.link, CID_LINK, id);
      assert.ok(BigInt(place.cid) <= MAX_ID && BigInt(place.cid) > 0n, id);
      assert.equal(place.link, `https://maps.google.com/?cid=${place.cid}`, id);
    }
  });

  test('Google country domains and maps.google.com count, look-alikes do not', () => {
    const path = '/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sCafes!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2';
    for (const host of ['www.google.no', 'www.google.co.uk', 'maps.google.com']) assert.equal(A(`https://${host}${path}`).maps.place.link, 'https://maps.google.com/?cid=2', host);
    for (const host of ['example.com', 'google.evil.io', 'notgoogle.com']) assert.equal(A(`https://${host}${path}`).maps, null, host);
  });

  test('a link left untouched (it holds a sign-in value) offers no Place only', () => {
    const r = A(`${M7.dirty}&token=abc`);
    assert.ok(r.untouched);
    assert.equal(r.maps, null);
  });

  test('the wording has no dashes, double hyphens or "safe"', () => {
    for (const c of [M6, M7]) {
      const text = note(A(c.dirty));
      assert.ok(!/[\u2013\u2014]|--/.test(text), text);
      assert.ok(!/\bsafe/i.test(text), text);
    }
  });
});
