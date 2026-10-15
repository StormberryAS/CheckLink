// Security and privacy review checks for the CheckLink engine (2026-10-10 review).
//
//   node --test tests/            (the gate runs this file with the others)
//
// Each test reproduces one finding of the security review and states what the fixed
// engine must do. Written as security-review.mjs, outside the gate, while the findings
// were open; renamed to security-review.test.mjs once every check passed, so the gate
// keeps them.
//
// Node 24 built-ins only. Nothing here touches the network.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse } from '../src/link-core.js';

// What Go to opens: app.js goTarget() uses a.openUrl(removed), which puts https:// in front
// only when the chosen clean link has no scheme of its own (finding 3).
const realHost = (a, ids) => {
  try {
    return new URL(a.openUrl(ids)).hostname;
  } catch {
    return null;
  }
};

// Every way of choosing parts: the defaults, everything ticked, nothing ticked.
const choices = (a) => [undefined, a.parts.map((p) => p.id), []];

test('a clean link never goes to a different host than the one the page names', () => {
  // The WHATWG parser skips any run of / and \ after "https:", so the authority of
  // https:///evil.example;jsessionid=abc@www.paypal.com/ is the whole
  // "evil.example;jsessionid=abc@www.paypal.com" and the host is www.paypal.com.
  // splitLink treats it as an empty authority and a path, so the ;jsessionid= path rule
  // cuts "@www.paypal.com" out and the clean link goes to evil.example.
  const links = [
    'https:///evil.example;jsessionid=abc@www.paypal.com/signin?utm_source=mail',
    'https://\\evil.example;jsessionid=abc@www.google.com/',
    'https:////evil.example;jsessionid=abc@www.google.com/',
    'https:///ref=x@www.amazon.com/',
  ];
  for (const link of links) {
    const a = analyse(link);
    assert.ok(a.found, link);
    for (const ids of choices(a)) {
      if (a.wrappers.length) continue;
      assert.equal(realHost(a, ids), a.host, `${link} with ${JSON.stringify(ids)} -> ${a.clean(ids)}`);
    }
  }
});

test('the host shown bold is the host the browser uses (backslash ends the authority)', () => {
  // https://evil.example\@www.google.com/ goes to evil.example; the page underlines
  // www.google.com as "where the link goes".
  const a = analyse('https://evil.example\\@www.google.com/');
  assert.equal(a.host, 'evil.example');
  assert.equal(a.hostAsWritten.toLowerCase(), 'evil.example');
  assert.ok(a.warnings.some((w) => w.tier === 'check'), 'the backslash still deserves a Check warning');
});

test('Go to on a bare link that keeps an inner wrapper opens the inner wrapper itself', () => {
  // Keeping w1 while w0 is removed makes clean() return the inner wrapper, which already
  // has its scheme; the bare link's https:// prefix then gives https://https://...
  const a = analyse('www.google.com/url?q=https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F%3Fgclid%3D1');
  assert.equal(a.wrappers.length, 2);
  const clean = a.clean(['w0']);
  assert.equal(clean.startsWith('https://l.facebook.com/'), true, clean);
  // What app.js goTarget() opens: a.openUrl(removed).
  assert.equal(realHost(a, ['w0']), 'l.facebook.com', a.openUrl(['w0']));
  assert.equal(a.openUrl(['w0']), clean, 'no second scheme in front of one that is already there');
});

test('bidi controls and other invisible characters before the host are named', () => {
  // U+202E in the user part reverses the rest of the line: the page shows the real host
  // moc.elgoog.ac, bold and underlined, as "ca.google.com".
  const a = analyse('https://‮moc.elgoog@moc.elgoog.ac/');
  assert.ok(a.warnings.some((w) => w.id === 'invisible' || /right-to-left/.test(w.text)), JSON.stringify(a.warnings));
});

test('Unicode tag characters (invisible) are named', () => {
  const a = analyse('https://example.com/pay\u{E0041}\u{E0042}now');
  assert.ok(a.warnings.some((w) => w.id === 'invisible'), JSON.stringify(a.warnings));
});

test('a javascript: link behind a zero-width space is still a Stop', () => {
  const a = analyse('​javascript:alert(document.domain)');
  assert.equal(a.kind, 'script');
});

test('a 20,000 character link ending in brackets is read in linear time', () => {
  // trimTrailing() splits the whole link twice for every trailing ) ] } so the cost is
  // quadratic: about 3 s here at the textarea limit and about 98 s at 100 KB.
  for (const ch of [')', ']', '}', '）']) {
    const text = `https://a.co/${ch.repeat(20000 - 13)}`;
    const t0 = performance.now();
    analyse(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `${JSON.stringify(ch)}: ${Math.round(ms)} ms`);
  }
});

test('the rule regexes stay fast on 100 KB of hostile input (no ReDoS)', () => {
  // Passes today; kept so a new rule with nested quantifiers is caught.
  const N = 100_000;
  const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const inputs = [
    `https://example.com/${rep('a')}`,
    `https://example.com/?${rep('utm_source=x&')}`,
    `https://example.com/#${rep('k=v&')}`,
    `https://example.com/?u=${rep('%41')}`,
    `https://www.google.com/url?q=${rep('https://www.google.com/url?q=')}`,
    `https://example.com/?${rep('u=https%3A%2F%2Fb.co%2F&')}`,
    rep('https://%%% '),
    rep('www.a.co '),
  ];
  for (const text of inputs) {
    const t0 = performance.now();
    analyse(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${JSON.stringify(text.slice(0, 40))}: ${Math.round(ms)} ms`);
  }
});
