// Corrections from the online verification of 10 October 2026, applied on 11 October 2026 to
// rules/extra-rules.json 1.7.0, NOTICE and tools/upstream.lock.json (on top of stage 2, which
// had already shipped licences/Inter-OFL-1.1.txt and the lock itself).
//
// Every wrapper and parameter the reviewers added from their own knowledge was checked
// online that day (live responses, real links, primary sources). All were right; four
// needed additions, which these tests hold:
//   * Teams Safe Links is also served from teams.public.onecdn.static.microsoft;
//   * AMP viewer links still kept amp_ct and csi in the fragment after cleaning;
//   * older Pinterest share links carry sender_id, not sender;
//   * QR Code Generator also serves its codes from q-r.to and l.ead.me.
// The rest of this file guards the paperwork: no rule from that review is still marked
// "not checked online", NOTICE names the rule version that ships, and every file
// tools/upstream.lock.json says is vendored is byte for byte what it records.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { analyse } from '../src/link-core.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const sha256 = (p) => createHash('sha256').update(read(p)).digest('hex');
const EXTRA = JSON.parse(read('rules/extra-rules.json'));
const LOCK = JSON.parse(read('tools/upstream.lock.json'));

const removed = (r) => r.parts.filter((p) => p.defaultRemove).map((p) => (p.where === 'fragment' ? `#${p.name}` : p.name)).sort();
const wrapperIds = (r) => r.wrappers.map((w) => w.id);
const enc = encodeURIComponent;

describe('Teams Safe Links on its second host', () => {
  const PATH = '/evergreen-assets/safelinks/2/atp-safelinks.html';
  const INNER = 'https://example.com/a?utm_source=x';

  test('teams.public.onecdn.static.microsoft is unwrapped, with the parameters the page reads', () => {
    const r = analyse(`https://teams.public.onecdn.static.microsoft${PATH}?url=${enc(INNER)}&locationOfClick=19&dest=x&pc=1`);
    assert.deepEqual(wrapperIds(r), ['teams-safelinks']);
    assert.equal(r.cleanLink, 'https://example.com/a');
  });

  test('the first host still works', () => {
    const r = analyse(`https://statics.teams.cdn.office.net/evergreen-assets/safelinks/1/atp-safelinks.html?url=${enc(INNER)}`);
    assert.deepEqual(wrapperIds(r), ['teams-safelinks']);
    assert.equal(r.cleanLink, 'https://example.com/a');
  });

  for (const [label, host] of [
    ['a longer host that only starts with the name', 'teams.public.onecdn.static.microsoft.evil.io'],
    ['a host that only ends with the name', 'evilteams.public.onecdn.static.microsoft.example'],
  ]) {
    test(`a look-alike is not unwrapped: ${label}`, () => {
      const link = `https://${host}${PATH}?url=${enc('https://example.com/')}`;
      const r = analyse(link);
      assert.deepEqual(wrapperIds(r), []);
      assert.equal(r.cleanLink, link);
    });
  }

  test('a look-alike is not unwrapped: the name as user info in front of another host', () => {
    // The user info is an address disguise (decision 11): the clean link drops it and
    // still goes to evil.io, never to the address inside.
    const r = analyse(`https://teams.public.onecdn.static.microsoft@evil.io${PATH}?url=${enc('https://example.com/')}`);
    assert.deepEqual(wrapperIds(r), []);
    assert.equal(new URL(r.cleanLink).hostname, 'evil.io');
    assert.ok(r.parts.some((p) => p.where === 'userinfo' && p.defaultRemove));
  });
});

describe('AMP viewer links clean down to the bare page', () => {
  // The shape of real shared links found on 10 October 2026: query values the AMP code
  // drops, and a fragment the viewer writes when the page is opened from Google.
  const PAGE = 'https://www.tomshardware.com/news/x';
  const VIEWER = `https://www-tomshardware-com.cdn.ampproject.org/v/s/www.tomshardware.com/news/x?amp_js_v=0.1&amp_gsa=1&usqp=mq331AQFKAGwASA%3D#aoh=16158517866717&csi=0&referrer=https%3A%2F%2Fwww.google.com&amp_tf=From%20%251%24s&amp_ct=1615851787919&ampshare=${enc(PAGE)}`;

  test('every viewer value goes, amp_ct and csi included', () => {
    const r = analyse(VIEWER);
    assert.deepEqual(wrapperIds(r), ['amp-cache']);
    assert.equal(r.cleanLink, PAGE);
    for (const n of ['amp_js_v', 'amp_gsa', 'usqp', '#aoh', '#csi', '#referrer', '#amp_tf', '#amp_ct', '#ampshare']) {
      assert.ok(removed(r).includes(n), `${n} goes: ${removed(r).join(' ')}`);
    }
  });

  test('aoh is described as a time, not an ID', () => {
    const aoh = analyse(VIEWER).parts.find((p) => p.name === 'aoh');
    assert.equal(aoh.provider, 'AMP viewer opening time');
  });

  test('csi on an ordinary page stays: it goes only next to aoh, amp_tf or ampshare', () => {
    assert.equal(analyse('https://example.org/page?csi=1').cleanLink, 'https://example.org/page?csi=1');
    assert.equal(analyse('https://example.org/page#csi=1').cleanLink, 'https://example.org/page#csi=1');
  });

  test('amp_ct, amp_r and amp_kit go wherever they appear, and the rest stays', () => {
    assert.equal(analyse('https://example.org/a?amp_r=1&amp_kit=2&amp_ct=3&b=4').cleanLink, 'https://example.org/a?b=4');
  });
});

describe('Pinterest and YouTube additions', () => {
  test('older Pinterest share links lose sender_id, as newer ones lose sender', () => {
    const r = analyse('https://www.pinterest.com/pin/123/feedback/?invite_code=ab12&sender_id=987654');
    assert.equal(r.cleanLink, 'https://www.pinterest.com/pin/123/feedback/');
    assert.equal(r.parts.find((p) => p.name === 'sender_id').provider, 'Pinterest sharer ID');
  });

  test('si goes on youtube-nocookie.com (checked) and on youtubekids.com (by extension)', () => {
    assert.equal(analyse('https://www.youtube-nocookie.com/embed/abc?si=xyz').cleanLink, 'https://www.youtube-nocookie.com/embed/abc');
    assert.equal(analyse('https://www.youtubekids.com/watch?v=abc&si=xyz').cleanLink, 'https://www.youtubekids.com/watch?v=abc');
  });
});

describe("QR Code Generator's other two domains", () => {
  for (const host of ['q-r.to', 'l.ead.me']) {
    test(`${host} is a dynamic QR code, like qrco.de`, () => {
      const r = analyse(`https://${host}/bfAbC1`);
      assert.deepEqual([r.shortLink.kind, r.shortLink.service], ['dynamic-qr', 'QR Code Generator']);
      assert.ok(r.warnings.some((w) => w.id === 'short-link'));
    });
  }
});

describe('the rule data records what was checked', () => {
  test('no rule from the review of 10 October 2026 is still marked "not checked online"', () => {
    // The only rules that may say so are the instagr.am copies of the instagram.com rules,
    // which decision IG-1 of 11 October 2026 adds by extension, not checked online, marked
    // verified false like si on youtubekids.com.
    const params = EXTRA.additions.hosts.flatMap((b) => b.params.map((p) => ({ pattern: b.pattern, ...p })));
    const unchecked = params.filter((p) => /not checked online/i.test(JSON.stringify(p)));
    assert.ok(unchecked.length > 0);
    for (const p of unchecked) {
      assert.deepEqual(p.pattern, ['instagr.am'], p.name);
      assert.equal(p.verified, false, p.name);
      assert.match(p.basis, /^By extension, not checked online: .*Decision IG-1 of 11 October 2026\.$/, p.name);
    }
    // The section's own description ends with a sentence about that decision.
    const [source, ig1] = EXTRA.additions.source.split(' Decision IG-1 of 11 October 2026 (stage 4b): ');
    assert.match(ig1, /by extension, not checked online\.$/);
    const others = { ...EXTRA.additions, source, hosts: EXTRA.additions.hosts.filter((b) => !(b.pattern.length === 1 && b.pattern[0] === 'instagr.am')) };
    assert.doesNotMatch(JSON.stringify(others), /not checked online/i);
    assert.doesNotMatch(EXTRA.canonical.source, /not checked online/i);
  });

  test('the six reviewer wrappers are verified and say how', () => {
    for (const id of ['linkedin-safety-go', 'threads-lphp', 'facebook-flx-warn', 'amazon-gp-r', 'teams-safelinks', 'steam-linkfilter']) {
      const w = EXTRA.additions.redirects.find((x) => x.id === id);
      assert.equal(w.verified, true, id);
      assert.match(w.note, /^Checked online on 10 October 2026/, id);
    }
  });

  test('the one rule resting on inference says so: si on youtubekids.com', () => {
    const kids = EXTRA.additions.hosts.find((h) => h.pattern.length === 1 && h.pattern[0] === 'youtubekids.com');
    assert.equal(kids.params[0].verified, false);
    assert.match(kids.params[0].basis, /^By extension, not observed/);
  });

  test('NOTICE names the rule versions that ship', () => {
    const notice = read('NOTICE').toString();
    assert.match(notice, new RegExp(`rules/extra-rules\\.json \\(version ${EXTRA.version.replace(/\./g, '\\.')},`));
    const provider = JSON.parse(read('rules/provider-rules.json'));
    assert.match(notice, new RegExp(`rules/provider-rules\\.json \\(version\\s+${provider.version.replace(/\./g, '\\.')},`));
  });
});

describe('tools/upstream.lock.json', () => {
  test('is the approved lock, not the proposal', () => {
    assert.equal(LOCK.name, 'CheckLink upstream lock');
    assert.equal('status' in LOCK, false);
  });

  test('every Inter file it lists is byte for byte what it records, and there are 39 of them', () => {
    const inter = LOCK.vendored.find((v) => v.id === 'inter');
    const files = Object.entries(inter.files);
    assert.equal(files.length, 39);
    for (const [path, hash] of files) assert.equal(sha256(path), hash, path);
  });

  test('the Inter licence ships, unchanged from the release', () => {
    const lic = LOCK.vendored.find((v) => v.id === 'inter').licence_file_in_zip;
    assert.equal(lic.shipped, 'licences/Inter-OFL-1.1.txt');
    assert.equal(sha256(lic.shipped), lic.sha256);
    assert.match(read(lic.shipped).toString(), /SIL OPEN FONT LICENSE Version 1\.1/);
  });

  test('a source marked planned lists no shipped files, so nothing ships unrecorded', () => {
    for (const v of LOCK.planned || []) {
      assert.match(v.role, /planned/, v.id);
      assert.equal(v.files, undefined, `${v.id} lists no shipped files`);
      assert.equal(v.path === undefined || !existsSync(new URL(v.path, root)), true, `${v.id} is not in the repository`);
    }
  });

  test('zxing-wasm carries an npm sha512 integrity for the shipped version, records that no newer one was waiting, and the lock names no local or temporary path', () => {
    const z = LOCK.vendored.find((v) => v.id === 'zxing-wasm');
    assert.match(z.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, z.version);
    assert.equal(z.tarball, `https://registry.npmjs.org/zxing-wasm/-/zxing-wasm-${z.version}.tgz`);
    assert.equal(z.version, '3.1.6');
    // 3.1.6 was npm's latest when it was vendored (2026-10-22), so there is no next candidate to record.
    assert.equal(z.next_candidate, null);
    assert.match(z.next_candidate_checked, /^2026-10-22: 3\.1\.6 is npm's latest/);
    for (const old of ['3.1.4', '3.1.5']) {
      assert.equal(existsSync(new URL(`vendor/zxing-wasm-${old}/`, root)), false, `${old} was replaced, not kept beside 3.1.6`);
    }
    assert.doesNotMatch(JSON.stringify(LOCK), /\/tmp\/|scratchpad|\/home\/|\/mnt\//);
  });

  test('provider-rules.json is the file the lock pinned, and the extra-rules entry names the version that ships', () => {
    const entry = LOCK.derived.find((d) => d.id === 'provider-rules');
    assert.equal(sha256('rules/provider-rules.json'), entry.sha256);
    assert.equal(LOCK.derived.find((d) => d.id === 'extra-rules').version, EXTRA.version);
  });
});
