// Stage 2: the Public Suffix List (src/psl.js, read by src/domain.js) and what it changes in
// the engine: who owns an address (the "Goes to" line, the bold part of the link, the
// warnings), provider patterns such as amazon.* decided by the list instead of the stopgap,
// and parameter names in mixed case (Utm_Source) matched like names in capitals.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PSL_COMMIT, PSL_DATE, PSL_VERSION, domainInfo, publicSuffix, registrableDomain } from '../src/domain.js';
import { analyse, hostMatches } from '../src/link-core.js';
import { checkAll } from '../tools/vendor.mjs';

const A = (link) => analyse(link);
const warn = (r, id) => r.warnings.find((w) => w.id === id);
const part = (r, name) => r.parts.find((p) => p.name === name);

describe('the Public Suffix List copy', () => {
  test('is the pinned version, and every third-party file matches tools/upstream.lock.json', () => {
    assert.equal(PSL_VERSION, '2026-10-07_07-28-19_UTC');
    assert.equal(PSL_DATE, '2026-10-07');
    assert.equal(PSL_COMMIT, '3929462652695bad04f0a27afb600974014a3c8b');
    const { errors } = checkAll({ release: false });
    assert.deepEqual(errors, []);
  });
  test('src/psl.js keeps the MPL-2.0 notice and says where it came from', () => {
    const src = readFileSync(new URL('../src/psl.js', import.meta.url), 'utf8');
    assert.match(src, /subject to the terms of the Mozilla Public\n\/\/ License, v\. 2\.0|Mozilla Public License, v\. 2\.0/);
    assert.match(src, /https:\/\/publicsuffix\.org\/list\/public_suffix_list\.dat/);
    assert.match(src, /licences\/Public-Suffix-List-MPL-2\.0\.txt/);
  });
});

describe('registrable domains (the spec’s own cases, and the list’s rules)', () => {
  test('askoy.no and tromsø.no are public suffixes themselves; bar.co.no and user.github.io belong to whoever made them; www.gov.br is its own domain', () => {
    assert.equal(registrableDomain('askoy.no'), null);
    assert.equal(publicSuffix('askoy.no').suffix, 'askoy.no');
    assert.equal(registrableDomain('www.askoy.no'), 'www.askoy.no');
    assert.deepEqual(domainInfo('bar.co.no'), { host: 'bar.co.no', suffix: 'co.no', domain: 'bar.co.no', private: true, known: true });
    assert.deepEqual(domainInfo('user.github.io'), { host: 'user.github.io', suffix: 'github.io', domain: 'user.github.io', private: true, known: true });
    assert.equal(registrableDomain('github.io'), null);
    assert.equal(registrableDomain('www.gov.br'), 'www.gov.br');
    assert.equal(registrableDomain('gov.br'), null);
    assert.equal(registrableDomain('xn--troms-zua.no'), null);
    assert.equal(registrableDomain('kart.xn--troms-zua.no'), 'kart.xn--troms-zua.no');
  });
  test('ordinary names, second-level suffixes, wildcards and exceptions', () => {
    assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
    assert.equal(registrableDomain('www.ck'), 'www.ck', '!www.ck beats *.ck');
    assert.equal(registrableDomain('a.b.ck'), 'a.b.ck');
    assert.equal(registrableDomain('foo.city.kawasaki.jp'), 'city.kawasaki.jp');
    assert.equal(registrableDomain('x.kawasaki.jp'), null);
  });
  test('IP addresses, single names, empty labels and junk give no domain; capitals and a trailing dot are folded', () => {
    for (const h of ['192.168.1.1', '[::1]', '', 'a..b', 'with space.com', 'résumé.com', null, 42]) assert.equal(registrableDomain(h), null, String(h));
    assert.equal(registrableDomain('localhost'), null);
    assert.equal(publicSuffix('localhost').known, false);
    assert.equal(registrableDomain('WWW.Example.COM.'), 'example.com');
  });
});

describe('provider patterns decided by the list (replaces the private-suffix stopgap)', () => {
  // The 28 names the stopgap (extra-rules.json suffix_deny, removed in 1.6.1) refused.
  const FORMER_DENY = ['ac.ru', 'co.bn', 'co.ca', 'co.cz', 'co.de', 'co.dk', 'co.nl', 'co.no', 'co.pl', 'co.ro', 'co.ua', 'com.de', 'com.ru', 'com.se', 'edu.ru', 'gov.nl', 'gov.ru', 'ltd.hk', 'ltd.ng', 'ltd.ua', 'mil.ru', 'net.ru', 'org.ru', 'org.yt', 'plc.ng', 'sch.ac', 'sch.tf', 'sch.wf'];
  test('every name the stopgap refused is still refused, because the list marks each one private', () => {
    for (const s of FORMER_DENY) {
      assert.equal(publicSuffix(`x.${s}`).private, true, s);
      assert.ok(!hostMatches(`google.${s}`, 'google.*') && !hostMatches(`www.amazon.${s}`, 'amazon.*'), s);
    }
  });
  test('ICANN suffixes match, at any depth of subdomain', () => {
    for (const [h, p] of [['amazon.co.uk', 'amazon.*'], ['www.amazon.com.br', 'amazon.*'], ['google.co.jp', 'google.*'], ['www.google.com.au', 'www.google.*'], ['music.amazon.co.uk', 'music.amazon.*'], ['x.music.amazon.de', 'music.amazon.*'], ['www.google.com.', 'google.*']]) {
      assert.ok(hostMatches(h, p), `${h} ${p}`);
    }
  });
  test('look-alikes and private or unknown suffixes do not', () => {
    for (const h of ['google.evil.io', 'google.com.evil.io', 'amazon.co.com', 'google.co.business', 'amazon.github.io', 'google.blogspot.com', 'google.local', 'amazon', 'notamazon.com', 'amazon.co.uk.evil.com']) {
      assert.ok(!hostMatches(h, 'google.*') && !hostMatches(h, 'amazon.*'), h);
    }
  });
  test('redirect wrappers and canonical rules written for name.* follow the list too', () => {
    assert.equal(A('https://www.google.co.uk/url?q=https://example.com/a&sa=D').host, 'example.com');
    assert.equal(A('https://www.google.co.business/url?q=https://example.com/a&sa=D').wrappers.length, 0);
    assert.equal(A('https://www.google.com.de/url?q=https://example.com/a&sa=D').wrappers.length, 0);
    const uk = A('https://www.amazon.co.uk/dp/B07XJ8C8F5?mystery=1');
    assert.ok(uk.parts.some((p) => p.unrecognised), 'the Amazon product rule applies on amazon.co.uk');
    const no = A('https://www.amazon.co.no/dp/B07XJ8C8F5?mystery=1');
    assert.ok(!no.parts.length, 'and not on amazon.co.no, which anyone can register under');
  });
});

describe('who owns the address, in the analysis and its warnings', () => {
  test('the analysis names the domain and where it sits in the host as written', () => {
    const r = A('https://SHOP.Example.co.uk/x?utm_source=a');
    assert.equal(r.domain, 'example.co.uk');
    assert.equal(r.domainAsWritten, 'Example.co.uk');
    assert.equal(r.domainStart, 5);
    assert.equal(r.site.suffix, 'co.uk');
    const idn = A('https://www.tromsø.no/kart');
    assert.equal(idn.domain, 'www.xn--troms-zua.no');
    assert.equal(idn.domainAsWritten, 'www.tromsø.no');
    assert.equal(idn.domainStart, 0);
    const ip = A('http://192.168.1.1/admin');
    assert.equal(ip.domain, null);
    assert.equal(ip.domainStart, -1);
    const wrapped = A(`https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://login.example.org/a')}&data=x`);
    assert.equal(wrapped.wrappers[0].site.domain, 'outlook.com');
    assert.equal(wrapped.target.domainAsWritten, 'example.org');
  });
  test('warnings lead with the owner when the host is a longer address under it, and leave www. alone', () => {
    assert.equal(warn(A('https://user@login.example.com/'), 'at-trick').text, 'Sign-in details are written into this address, before the @. Anyone who gets the link can read them. It goes to example.com (full name: login.example.com).');
    assert.match(warn(A('https://paypal.com@paypal.com.secure-login.evil.co.uk/'), 'at-trick').text, /It goes to evil\.co\.uk \(full name: paypal\.com\.secure-login\.evil\.co\.uk\): make sure/);
    assert.match(part(A('http://google.com@login.kaspersky.com/blog/'), 'Address disguise').reveals, /The link goes to kaspersky\.com \(full name: login\.kaspersky\.com\)\.$/);
    assert.match(warn(A('https://example.com/go?next=https://accounts.evil.example/x'), 'hidden-address').text, /It points to evil\.example \(full name: accounts\.evil\.example\)\.$/);
    assert.match(warn(A('https://google.com@www.kaspersky.com/'), 'at-trick').text, /It goes to www\.kaspersky\.com: make sure/);
  });
  test('an address under a name anyone can make addresses under is good to know about, plainly', () => {
    const w = warn(A('https://user.github.io/login'), 'shared-domain');
    assert.equal(w.tier, 'info');
    assert.equal(w.text, 'Anyone can make an address under github.io, so user.github.io belongs to whoever made it, not necessarily to whoever runs github.io.');
    assert.ok(warn(A('https://shop.co.no/'), 'shared-domain'));
    assert.equal(warn(A('https://github.com/x'), 'shared-domain'), undefined);
    assert.equal(warn(A('https://github.io/'), 'shared-domain'), undefined, 'github.io itself has no domain of its own');
    assert.ok(A('https://user.github.io/').warnings.every((x) => x.tier === 'info'), 'it alone never hides "No warning signs found"');
  });
});

describe('parameter names in mixed case', () => {
  test('Utm_Source, UTM_Source, utm_Campaign, Fbclid and GClid are removed like their small-letter names', () => {
    const r = A('https://example.com/a?Utm_Source=x&UTM_Medium=y&utm_Campaign=z&Fbclid=abc123def456ghi&GClid=EAIaIQob&id=1');
    assert.equal(r.cleanLink, 'https://example.com/a?id=1');
    assert.equal(part(r, 'Fbclid').provider, part(A('https://example.com/a?fbclid=abc'), 'fbclid').provider);
    assert.equal(part(r, 'Utm_Source').provider, part(A('https://example.com/a?utm_source=x'), 'utm_source').provider);
  });
  test('a short opaque name in other letters is not caught (Gad, Awc): a site may use it for something else', () => {
    const r = A('https://example.com/?Gad=1&Awc=2');
    assert.equal(r.cleanLink, 'https://example.com/?Gad=1&Awc=2');
    assert.equal(r.parts.length, 0);
    assert.ok(part(A('https://example.com/?gad=1'), 'gad'), 'gad in small letters is still found');
  });
  test('a rule written in mixed case still matches only as written, and protected names are never removed by a global rule', () => {
    const fb = A('https://www.facebook.com/x?Source=a&SoUrce=b&source=c');
    assert.equal(part(fb, 'Source').defaultRemove, true);
    assert.equal(part(fb, 'SoUrce').ask, true);
    assert.equal(part(fb, 'source').ask, true);
    const p = A('https://example.com/?Ref=a&Hl=no&Lang=en');
    assert.equal(p.parts.length, 0);
    assert.equal(p.cleanLink, 'https://example.com/?Ref=a&Hl=no&Lang=en');
  });
  test('functional names in mixed case are kept on purpose, and camelCase names the site uses are left alone', () => {
    const yt = A('https://www.youtube.com/watch?v=abc&Index=2');
    assert.ok(yt.kept.some((k) => k.name === 'Index'));
    const am = A('https://music.amazon.com/albums/B0?trackAsin=B1');
    assert.ok(am.kept.some((k) => k.name === 'trackAsin'));
    assert.equal(am.cleanLink, 'https://music.amazon.com/albums/B0?trackAsin=B1');
  });
  test('names in capitals behave as before (UTM_SOURCE from a QR code)', () => {
    assert.equal(A('HTTPS://EXAMPLE.COM/A?UTM_SOURCE=QR&ID=7').cleanLink, 'HTTPS://EXAMPLE.COM/A?ID=7');
  });
});
