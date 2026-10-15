// Address disguise (spec decision 11, Marcos's test M8 of 10 October 2026): the user name
// (and password) before @ is a removable part, ticked by default, in the Check tier. The
// clean link drops it, keeps the scheme as written, and the warnings stay. A link left
// untouched (a sign-in or reset value, a signature) keeps it. Run from the repository root
// with: node --test tests/
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
const disguise = (r) => r.parts.find((p) => p.where === 'userinfo');
const warnIds = (r) => r.warnings.map((w) => w.id);

describe('address disguise', () => {
  const M8 = 'http://convincing-business-related-page-name-pretending-to-be-on-google.com@kaspersky.com/blog/';

  test("M8: Marcos's link comes back as http://kaspersky.com/blog/, the warnings stay", () => {
    const r = A(M8);
    assert.equal(r.cleanLink, 'http://kaspersky.com/blog/');
    assert.equal(r.host, 'kaspersky.com');
    assert.deepEqual(warnIds(r).sort(), ['at-trick', 'not-encrypted']);
    assert.ok(r.warnings.every((w) => w.tier === 'check'));
  });

  test('M8: the part is u0, ticked, in the Check tier, with the row Marcos asked for', () => {
    const p = disguise(A(M8));
    assert.deepEqual(
      { id: p.id, name: p.name, value: p.value, provider: p.provider, defaultRemove: p.defaultRemove, ask: p.ask, unique: p.unique, tier: p.tier, rule: p.rule, text: p.text, unrecognised: p.unrecognised },
      {
        id: 'u0', name: 'Address disguise', value: 'convincing-business-related-page-name-pretending-to-be-on-google.com', provider: null,
        defaultRemove: true, ask: false, unique: false, tier: 'check', rule: 'address-disguise',
        text: 'convincing-business-related-page-name-pretending-to-be-on-google.com@', unrecognised: false,
      },
    );
    assert.equal(p.reveals, 'Everything before @ is not where this goes. It is there to make the address look like convincing-business-related-page-name-pretending-to-be-on-google.com. The link goes to kaspersky.com.');
  });

  test('unticked, the disguise stays byte for byte; the segments mark it either way', () => {
    const r = A(M8);
    assert.equal(r.clean([]), M8);
    assert.ok(r.segmentsFor([]).some((s) => s.partId === 'u0' && !s.removed));
    assert.ok(r.segments.some((s) => s.partId === 'u0' && s.removed && s.text.endsWith('@')));
  });

  for (const [label, link, clean, look] of [
    ['a user name and password', 'https://www.paypal.com:secure@evil.example/login?utm_source=x', 'https://evil.example/login', 'www.paypal.com:secure'],
    ['a percent-encoded @ inside the user name', 'https://www.google.com%40accounts@evil.example/', 'https://evil.example/', 'www.google.com@accounts'],
    ['a user name written in percent-encoding', 'https://%77%77%77.google.com@evil.example/', 'https://evil.example/', 'www.google.com'],
    ['two @ signs', 'https://a@b@evil.example/x', 'https://evil.example/x', 'a@b'],
    ['a port after the host', 'https://bank.example@evil.example:8443/x', 'https://evil.example:8443/x', 'bank.example'],
    ['a run of slashes after the scheme', 'https:///bank.example@evil.example/', 'https:///evil.example/', 'bank.example'],
    // Batch 3 review finding P4: what is left of a bare link gets https://, so it still reads as a link.
    ['an address without a scheme', 'www.google.com@evil.example/x', 'https://evil.example/x', 'www.google.com'],
  ]) {
    test(`${label}: ${link}`, () => {
      const r = A(link);
      assert.equal(r.cleanLink, clean);
      assert.equal(disguise(r).value, look);
      assert.equal(new URL(r.openUrl()).hostname, r.host);
      assert.ok(warnIds(r).includes('at-trick'));
    });
  }

  test('a direction override before @ is named as a visible mark in the row, never applied', () => {
    const r = A('https://‮moc.elgoog@moc.elgoog.ac/');
    const p = disguise(r);
    assert.equal(p.value, '[U+202E]moc.elgoog');
    assert.ok(!p.reveals.includes('‮'));
    assert.equal(r.cleanLink, 'https://moc.elgoog.ac/');
    assert.ok(warnIds(r).includes('invisible'));
  });

  test('a long disguise is shortened in the row, keeping its end', () => {
    const p = disguise(A(`https://${'a'.repeat(100)}.google.com@evil.example/`));
    assert.ok(p.value.length <= 71 && p.value.endsWith('aaaa.google.com') && p.value.includes('…'), p.value);
  });

  test('a wrapped address with a disguise: the wrapper and the disguise go', () => {
    const r = A('https://www.google.com/url?q=https%3A%2F%2Fgoogle.com%40evil.example%2Fx&sa=D');
    assert.equal(r.cleanLink, 'https://evil.example/x');
    assert.deepEqual(r.parts.map((p) => p.where), ['wrapper', 'userinfo']);
  });

  test('on a canonical page the disguise and the page parameters both go', () => {
    assert.equal(A('https://bank.example@www.instagram.com/p/DeTqc0NDifd/?unknownid=1').cleanLink, 'https://www.instagram.com/p/DeTqc0NDifd/');
  });

  for (const [label, link, id] of [
    ['a reset token', 'https://user@example.com/reset?token=abc123', 'auth'],
    ['a signed storage link', 'https://user@bucket.s3.amazonaws.com/file.pdf?X-Amz-Signature=abc&X-Amz-Credential=x', 'signed'],
  ]) {
    test(`a link left untouched keeps its user name: ${label}`, () => {
      const r = A(link);
      assert.equal(r.untouched && r.untouched.id, id);
      assert.equal(r.cleanLink, link);
      assert.equal(disguise(r), undefined);
      assert.ok(warnIds(r).includes('at-trick'), 'the warning still says where it goes');
    });
  }

  for (const link of ['https://@example.com/', 'https://:@example.com/', 'https://evil.example\\@www.google.com/', 'https://example.com/path@x?a=b@c']) {
    test(`no disguise part where there is no user name: ${link}`, () => {
      const r = A(link);
      assert.equal(disguise(r), undefined);
      assert.equal(r.cleanLink, link);
    });
  }

  test('the disguise row uses no em dash, "safe", exclamation mark or alarm word', () => {
    for (const r of seen) {
      const p = disguise(r);
      if (!p) continue;
      for (const t of [p.name, p.reveals]) {
        assert.ok(!/—|–|--/.test(t) && !/\bsafe/i.test(t) && !t.includes('!') && !/\b(scam\w*|fake|malicious|danger\w*)\b/i.test(t), t);
      }
    }
  });

  test('segments cover the link and clean() equals the kept segments for every choice', () => {
    for (const r of seen) {
      if (!r.found) continue;
      const ids = r.parts.filter((p) => p.where !== 'wrapper').map((p) => p.id);
      for (let mask = 0; mask < 1 << ids.length; mask++) {
        const choice = ids.filter((_, i) => mask & (1 << i));
        const segs = r.target.segmentsFor(choice);
        assert.equal(segs.map((s) => s.text).join(''), r.target.link);
        // A bare link whose disguise goes gets https:// in front (finding P4).
        const prefix = r.bare && !r.wrappers.length && choice.includes('u0') ? 'https://' : '';
        assert.equal(r.clean([...r.wrappers.map((w) => w.partId), ...choice]), prefix + segs.filter((s) => !s.removed).map((s) => s.text).join(''));
      }
      assert.equal(new URL(r.openUrl()).hostname, r.target.host, r.link);
    }
  });
});
